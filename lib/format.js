/**
 * wows-helper · 面向模型的文本组装
 * ================================
 *
 * 这一层看似琐碎，却直接决定模型会不会照着数据说话。三条原则：
 *
 * 1. **数字必须照抄**：数据块里显式写明"数字照抄、不要改写"，否则模型很容易把
 *    `52.3%` 说成"五成多"，或把场次记错。
 * 2. **图片状态必须说清**：模型看不到图片内容。若不告诉它"已发出 / 未发送"，
 *    它就会重复发送，或者干脆对图片只字不提。
 * 3. **长度必须有上限**：一条超长水表足以撑爆整轮提示词（还会破坏前缀缓存），
 *    因此按 `contextDataMaxChars` 截断，并留下可见的截断标记。
 */

/**
 * 安全截断：超长时截断并附上可见标记。
 *
 * @param {string} text 原始文本。
 * @param {number} max 最大字符数（内部下限 50，避免调用方传入过小值导致内容全被切掉）。
 * @returns {string} 截断后的文本；未超长时原样返回。
 * @remarks 截断标记不可省：否则模型会以为"数据就这么多"，进而给出错误的结论。
 */
export function clip(text, max) {
  const s = String(text ?? '');
  const n = Math.max(50, Number(max) || 1600);
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…（数据过长已截断，需要更多细节可让群友把指令问得更具体）`;
}

/**
 * 判断桥接返回体里是否存在可用内容（文本或图片）。
 *
 * @param {object} data 桥接响应体。
 * @returns {boolean}
 */
export function resultHasData(data) {
  if (!data || typeof data !== 'object') return false;
  return !!(String(data.text ?? '').trim() || data.image_base64);
}

/**
 * Hikari 状态码的中文说明。
 * @param {string} status `success` | `wait` | `failed` | `error`。
 * @returns {string} 面向模型的中文短语。
 */
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
 * @param {boolean} [requireAt=true] 是否要求用户回复时 @ 机器人（对应 `requireAt` 配置）。
 * @returns {string} 一段中文提示。
 *
 * @remarks 三条约束，缺一条用户就会卡住：
 * 1. **选择列表图已经由插件直接发出**（见 `index.js` 的 wait 分支）——
 *    所以这里要明确告诉模型"别再发一次图"，否则它会调发送工具重复刷屏；
 * 2. **必须让群友 @机器人 后回序号**。这与序号回复的认领规则一致
 *    （见 `lib/trigger.js` 的 `parseSelectIndex`）。早期文案写的是"直接回数字即可"，
 *    与实际规则矛盾，群友照做就认不上；
 * 3. 钩子路径与工具路径共用此文案，避免两处措辞漂移。
 */
export function waitingHint(requireAt = true) {
  return requireAt
    ? '状态：需要用户选择 —— 选择列表图已由插件直接发到群里。'
      + '你只需用一句话提醒群友**@机器人**后回复序号（例如「@机器人 2」），可以说"看图选几"。'
      + '不要自己再发一次图。必须让他 @机器人：不 @ 的裸数字系统不会认。'
    : '状态：需要用户选择 —— 选择列表图已由插件直接发到群里。'
      + '你只需用一句话提醒群友回复序号（直接回数字即可）。不要自己再发一次图。';
}

/**
 * 把待选项渲染成编号列表。
 *
 * @param {Array} options 归一化后的待选项（元素形如 `{ name }`）。
 * @param {number} [limit=12] 最多条数。
 * @returns {string} 形如 `1. 大和\n2. 大和改`；无选项时为空串。
 */
export function formatOptions(options, limit = 12) {
  return (Array.isArray(options) ? options : [])
    .slice(0, Math.max(1, limit))
    .map((o, i) => `${i + 1}. ${String(o?.name ?? o?.text ?? o ?? '').slice(0, 60)}`)
    .join('\n');
}

/**
 * 钩子用：把一次预取结果写成注入上下文的块。
 * 输出形如：
 *   【yuyuko 自动查询结果】
 *   指令：yuyuko 大和 ｜ 状态：查询成功
 *   数据（照抄，不要改写数字）：
 *   ...
 *   渲染图已由插件自动发出（不要在正文里说"我没看到图"，也不要用发送工具重复发送）。
 */
export function buildContextNote({ command, data, autoSendImage = true, maxChars = 1600, includeData = true, requireAt = true } = {}) {
  const status = String(data?.status ?? 'error');
  const text = String(data?.text ?? '').trim();
  const hasImage = !!data?.image_base64;
  const lines = ['【yuyuko 自动查询结果】', `指令：yuyuko ${command || '帮助'} ｜ 状态：${statusHint(status)}`];

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
    return result.text || `指令 yuyuko ${command} 需要用户选择，但服务端没有给出待选项。`;
  }
  if (status !== 'success') {
    return `【yuyuko 查询结果】\n指令：yuyuko ${command}\n状态：${statusHint(status)}\n${clip(text || '服务端没有给出说明', 800)}\n（这次没查到，据实说明，不要编造成绩。）`;
  }

  const lines = [`【yuyuko 查询结果】`, `指令：yuyuko ${command} ｜ 状态：查询成功`];
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
