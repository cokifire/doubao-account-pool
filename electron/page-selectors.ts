/**
 * 页面控件定位常量集中处。
 *
 * 豆包前端的类名和文案会随版本漂移，稳定结构属性（data-*）才是首选；
 * 文本/类名匹配只作为受控回退。前端改版时优先改这里，而不是散落在执行脚本里。
 */

/** 创作栏「模型」控件（2026-08 起豆包在创作栏上暴露的稳定属性）。 */
export const VIDEO_MODEL_CONTROL_SELECTOR = '[data-input-engine-actionbar-control-key="video-model"]';

/** 「比例 + 时长」组合控件。 */
export const VIDEO_COMPOSITE_CONTROL_SELECTOR = '[data-creation-params-panel-id]';

/** 输入框候选：页面可能用 textarea、contenteditable 或 role=textbox。 */
export const COMPOSER_EDITABLE_SELECTOR = 'textarea, [contenteditable], [role="textbox"], input[type="text"]';
