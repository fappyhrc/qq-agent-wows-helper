// wows-helper · 把桥接返回的数据组装成"给模型看的文本"
//
// 这一层看着琐碎，但决定了模型会不会照着数据说话。原则三条：
//   1. **数字照抄**：数据块里显式写上"照抄、不要改写"，否则模型很容易把 52.3% 写成"五成多"。
//   2. **明确说清图片状态**：图发了没有必须写在文本里。模型看不到图，
//      不告诉它"已发出/未发送"，它就会重复发、或者干脆不提图。
//   3. **有上限**：一条超长水表能把整轮提示词撑爆（还吃缓存前缀），
//      所以按 contextDataMaxChars 截断，并注明"已截断"。

/** 安全截断，末尾给出可见的截断标记（别让模型以为数据就这么短）。 */
export function clip(text, max) {
  const s = String(text ?? '');
  const n = Math.max(50, Number(max) || 1600);
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…（数据过长已截断，需要更多细节可让群友把指令问得更具体）`;
}

/** 桥接返回里有没有可用的东西（文本或图片）。 */
export function resultHasData(data) {
  if (!data || typeof data !== 'object') return false;
  return !!(String(data.text ?? '').trim() || data.image_base64);
}

function statusHint(status) {
  switch (String(status ?? '')) {
    case 'success': return '查询成功';
    case 'wait': return '需要用户选择';
    case 'failed': return '查询失败（服务端没找到对应数据）';
    case 'error': return '服务端内部错误';
    default: return String(status ?? '未知状态');
  }
}

/**
 * 「需要用户选择」时给模型的统一提示语。
 *
 * ⚠️ 必须和"序号回复的认领规则"保持一致：requireAt 打开时，用户回复序号**也要 @ 机器人**
 * （见 lib/trigger.js 的 parseSelectIndex）。这里写死"请对方回复：@我 2"，
 * 免得模型只说"回复 2"，用户回了裸数字反而认不上。
 * 钩子路径与工具路径共用这一份文案，两处措辞不会漂移。
 */
export function waitingHint(requireAt = true) {
  return requireAt
    ? '状态：需要用户选择 —— 请用一句话请群友选择，并让他 @机器人 后回复序号（例如「@机器人 2」）。'
      + '他这样回复后，下一句会带着同一批上下文自动续查。'
    : '状态：需要用户选择 —— 请用一句话请群友回复序号（直接回数字即可）。'
      + '他回复后，下一句会带着同一批上下文自动续查。';
}

/** 把待选项渲染成缩进列表（最多 12 条），钩子与工具共用。 */
export function formatOptions(options, limit = 12) {
  return (Array.isArray(options) ? options : [])
    .slice(0, Math.max(1, limit))
    .map((o, i) => `${i + 1}. ${String(o?.name ?? o?.text ?? o ?? '').slice(0, 60)}`)
    .join('\n');
}

/**
 * 钩子用：把一次预取结果写成注入上下文的块。
 * 输出形如：
 *   【wws 自动查询结果】
 *   指令：wws 大和 ｜ 状态：查询成功
 *   数据（照抄，不要改写数字）：
 *   ...
 *   渲染图已由插件自动发出（不要在正文里说"我没看到图"，也不要用发送工具重复发送）。
 */
export function buildContextNote({ command, data, autoSendImage = true, maxChars = 1600, includeData = true, requireAt = true } = {}) {
  const status = String(data?.status ?? 'error');
  const text = String(data?.text ?? '').trim();
  const hasImage = !!data?.image_base64;
  const lines = ['【wws 自动查询结果】', `指令：wws ${command || '帮助'} ｜ 状态：${statusHint(status)}`];

  if (status === 'wait') {
    const options = Array.isArray(data?.options) ? data.options : [];
    lines.push(waitingHint(requireAt));
    if (options.length) {
      lines.push('待选项：');
      lines.push(formatOptions(options));
    }
    if (text) lines.push(`服务端提示：${clip(text, 300)}`);
    return lines.join('\n');
  }

  if (status !== 'success') {
    lines.push(`结果：${clip(text || '服务端没有给出说明', 500)}`);
    lines.push('这条指令这次没查到东西。据实说明即可，不要编造成绩。');
    return lines.join('\n');
  }

  if (!includeData) {
    // "不注入查询数据"：查询已经做完了（图也按配置发了），只是不把长文本塞进提示词。
    // 状态与图片信息仍然要给 —— 否则模型不知道刚才发生了什么，会重复查一遍。
    lines.push(`查询已完成（状态：${statusHint(status)}）。按设置本次不把数据文本注入上下文；`
      + '需要具体数字时调用 wows-query 工具重查一次（command 填同样的指令）。');
  } else if (text) {
    lines.push('数据（真实数据，数字照抄，不要改写或估算）：');
    lines.push(clip(text, maxChars));
  } else if (hasImage) {
    lines.push('本次结果只有图片形式（战绩长图），没有文字数据。');
  } else {
    lines.push('服务端返回成功但没有内容。');
  }

  if (hasImage) {
    lines.push(autoSendImage
      ? '渲染图已由插件自动发出（走的是发送队列）。不要再调用 wows-send-image 重复发送同一张图，也不要说"我看不到图"。'
      : '渲染图未发送（自动发送已关闭）。需要把图发出去时，调用 wows-helper__wows-send-image 工具。');
  }
  lines.push('接话要求：可以只点评一两句，也可以只发图；不要逐行念表格。');
  return lines.join('\n');
}

/**
 * 工具用：模型主动查询后的返回文本。比上下文块多两样东西 ——
 * 本次会话是否有图可补发、以及明确的"下一步该做什么"。
 */
export function formatResultText(result, config = {}) {
  const status = String(result?.status ?? 'error');
  const command = String(result?.command ?? '').trim();
  const text = String(result?.text ?? '').trim();
  const image = result?.image || null;
  const sentInfo = result?.sentInfo || null;

  if (status === 'wait') {
    return result.text || `指令 wws ${command} 需要用户选择，但服务端没有给出待选项。`;
  }
  if (status !== 'success') {
    return `【wws 查询结果】\n指令：wws ${command}\n状态：${statusHint(status)}\n${clip(text || '服务端没有给出说明', 800)}\n（这次没查到，据实说明，不要编造成绩。）`;
  }

  const lines = [`【wws 查询结果】`, `指令：wws ${command} ｜ 状态：查询成功`];
  lines.push(text ? `数据（真实数据，数字照抄）：\n${clip(text, config.contextDataMaxChars || 1600)}` : '本次结果只有图片形式（战绩长图），没有文字数据。');

  if (image) {
    if (image.oversized) {
      lines.push(`渲染图 ${(image.bytes / 1048576).toFixed(1)}MB 超过体积上限，本次没有发送。`);
    } else if (image.sent || sentInfo?.ok) {
      lines.push('渲染图已发给当前聊天（发送队列已留档）。不需要再发一次。');
    } else if (sentInfo && !sentInfo.ok) {
      lines.push(`渲染图发送失败：${sentInfo.error}。可以再调一次 wows-send-image 重试。`);
    } else {
      lines.push('渲染图尚未发送。需要发图就调用 wows-helper__wows-send-image 工具（同一张图只会发一次，重复调用会被去重拦下）。');
    }
  } else {
    lines.push('本次没有渲染图（文本类结果）。');
  }
  return lines.join('\n');
}
