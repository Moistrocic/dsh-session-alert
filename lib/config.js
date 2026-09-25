/**
 * 配置的读写与归一化。
 *
 * 配置落在 `$DSH_HOME/dsh-session-alert/config.json`：纯用户数据，与 settings.yaml
 * 分开——本插件有自己的设置页。
 *
 * 归一化的原则是**永不失败**：未知键与类型不符的字段一律丢弃，越界的数值钳进范围。
 * 用户手改坏了配置文件时，插件必须仍能启动并给出一个可用的默认值，而不是拒绝加载。
 *
 * @module dsh-session-alert/config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MAX_DURATION_SECONDS,
  SCENARIOS,
  SCENARIO_IDS,
  defaultConfig,
} from './contract.js'

/** 解析 DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`。与 DSH 自身约定一致。 */
export function resolveHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 配置文件路径。 */
export function configFilePath(env = process.env) {
  return join(resolveHome(env), 'dsh-session-alert', 'config.json')
}

/** 把数值钳进范围；非法值回退到 fallback。 */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** 只接受布尔；其他一律回退。 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 只接受非空字符串；其他回退。 */
function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/** 判断是否为普通对象（非 null、非数组）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一化一份配置。任何输入都返回一个完整可用的配置对象。
 * @param input - 来自文件或调用方的原始值。
 * @returns 归一化后的配置。
 */
export function normalizeConfig(input) {
  const base = defaultConfig()
  if (!isRecord(input)) return base

  const out = {
    enabled: boolOr(input.enabled, base.enabled),
    title: stringOr(input.title, base.title).trim() || base.title,
    sound: boolOr(input.sound, base.sound),
    onlyRootSessions: boolOr(input.onlyRootSessions, base.onlyRootSessions),
    skipAbortedTurns: boolOr(input.skipAbortedTurns, base.skipAbortedTurns),
    suppressWhenFocused: boolOr(input.suppressWhenFocused, base.suppressWhenFocused),
    chime: { ...base.chime },
    rateLimit: { ...base.rateLimit },
    scenarios: {},
  }

  if (isRecord(input.chime)) {
    out.chime.enabled = boolOr(input.chime.enabled, base.chime.enabled)
    const source = input.chime.source
    out.chime.source = (source === 'system' || source === 'file') ? source : base.chime.source
    out.chime.filePath = stringOr(input.chime.filePath, base.chime.filePath)
  }

  if (isRecord(input.rateLimit)) {
    out.rateLimit.enabled = boolOr(input.rateLimit.enabled, base.rateLimit.enabled)
    out.rateLimit.max = clampInt(input.rateLimit.max, 1, 100, base.rateLimit.max)
    out.rateLimit.windowSeconds = clampInt(input.rateLimit.windowSeconds, 1, 3600, base.rateLimit.windowSeconds)
    out.rateLimit.coalesce = boolOr(input.rateLimit.coalesce, base.rateLimit.coalesce)
  }

  // 场景：**以 SCENARIOS 为准遍历**，而不是遍历输入。
  // 这样文件里多出来的未知场景会被自然丢弃，已有场景缺失时也能补齐默认值。
  const inputScenarios = isRecord(input.scenarios) ? input.scenarios : {}
  for (const id of SCENARIO_IDS) {
    const fallback = base.scenarios[id]
    const raw = inputScenarios[id]
    if (!isRecord(raw)) {
      out.scenarios[id] = { ...fallback }
      continue
    }
    out.scenarios[id] = {
      enabled: boolOr(raw.enabled, fallback.enabled),
      minIntervalSeconds: clampInt(raw.minIntervalSeconds, 0, 3600, fallback.minIntervalSeconds),
      durationSeconds: clampInt(raw.durationSeconds, 0, MAX_DURATION_SECONDS, fallback.durationSeconds),
      // 空模板是有意义的意图（用户想让该场景不说话），但完全空白的模板会渲染出空通知，
      // 因此回退到默认。真正想静音应该关掉场景开关。
      body: (() => {
        const body = stringOr(raw.body, fallback.body)
        return body.trim().length === 0 ? fallback.body : body
      })(),
    }
  }

  return out
}

/**
 * 读取配置。文件不存在、不可读、或 JSON 损坏时都返回默认配置，
 * 并把原因交给调用方记录，而不是抛出。
 * @param onProblem - 可选的问题回调。
 * @returns 归一化后的配置。
 */
export function loadConfig(onProblem, env = process.env) {
  const path = configFilePath(env)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // 首次运行时文件本来就不存在，这不算问题。
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return defaultConfig()
    if (typeof onProblem === 'function') onProblem(`无法读取配置文件 ${path}：${String(error)}`)
    return defaultConfig()
  }
  try {
    return normalizeConfig(JSON.parse(text))
  } catch (error) {
    if (typeof onProblem === 'function') onProblem(`配置文件不是合法 JSON，已改用默认值：${String(error)}`)
    return defaultConfig()
  }
}

/**
 * 原子保存配置。
 *
 * 先写临时文件再 rename：这样即使中途失败，原文件也不会变成半截内容——
 * 配置文件损坏会让用户丢掉全部模板，代价远大于多写一个临时文件。
 *
 * @returns 是否保存成功。
 */
export function saveConfig(config, env = process.env) {
  const path = configFilePath(env)
  const normalized = normalizeConfig(config)
  const temp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
    return true
  } catch {
    return false
  }
}

/**
 * 渲染一条模板。
 *
 * 变量用 `{名字}` 形式。未知变量会被替换成空串而不是原样保留——原样保留会让
 * 通知里出现 `{typo}` 这种字面量，用户会以为是插件坏了。
 *
 * 变量值里的花括号不会被二次解释（替换是一次性的），因此变量内容不会变成模板。
 *
 * @param template - 模板文本。
 * @param vars - 变量值表。
 * @returns 渲染后的文本（已折叠空白）。
 */
export function renderTemplate(template, vars) {
  if (typeof template !== 'string') return ''
  const values = isRecord(vars) ? vars : {}
  // 匹配**任意** `{...}`，而不是只匹配 ASCII 变量名。
  //
  // 实测过的一个真实缺陷：只匹配 `[a-zA-Z][a-zA-Z0-9_]*` 时，用户把占位符打错成
  // `{会话}`（中文）会被原样留在通知里。用户看到 `{会话}` 会以为插件坏了，
  // 而它只是一处笔误。未知变量一律清空，让笔误表现为「少了一段」而不是
  // 「吐出一个花括号字面量」。
  const rendered = template.replace(/\{([^{}]*)\}/g, (_match, name) => {
    const key = String(name).trim()
    const value = values[key]
    return value === undefined || value === null ? '' : String(value)
  })
  // 兜底去掉残留的花括号。
  //
  // 嵌套写法（如 `{b{c}d}`）经上面的替换会剩下外层括号，单个多余括号（如 `a { b`）
  // 也不会被匹配。通知是给人看一眼的产物，里面出现花括号只会让人以为插件坏了。
  // 模板里正常不需要字面量花括号，所以直接清掉是安全的。
  return rendered.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}

/** 场景定义按 id 查表，供渲染与设置页共用。 */
export const SCENARIO_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]))
