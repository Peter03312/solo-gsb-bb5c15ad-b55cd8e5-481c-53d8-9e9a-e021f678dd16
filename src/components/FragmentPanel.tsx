import { useMemo } from 'react'
import {
  fragmentOffsetUnits,
  fragmentTotalLength,
  IPV4_HEADER_BYTES,
  MAX_HOPS,
  MAX_MTU,
  MAX_PAYLOAD_BYTES,
  MIN_MTU,
  MIN_PAYLOAD_BYTES,
  parseMtu,
  parsePayloadBytes,
  simulateFragmentation,
  type Fragment,
} from '../lib/fragment'
import { reconcileHosts, type HostRow } from '../lib/hosts'
import { intToIp } from '../lib/ip'
import type { FragHopInput, PlanResult, HostAssignment } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  /** 发送设备（主机登记稳定 ID；失效时保留选择并暂停预演） */
  deviceId: string
  /** 负载字节数文本（1 ~ 65515） */
  payload: string
  /** DF 开关（true = DF 置 1，禁止分片） */
  df: boolean
  /** 按经过顺序排列的 1 ~ 8 跳 MTU 录入 */
  hops: FragHopInput[]
  onDeviceChange: (id: string) => void
  onPayloadChange: (v: string) => void
  onDfChange: (v: boolean) => void
  onHopsChange: (next: FragHopInput[]) => void
}

let hopCounter = 0
function hopUid(): string {
  hopCounter += 1
  return `hop-${Date.now()}-${hopCounter}`
}

/** 单跳 MTU 录入的实时校验视图（空白行为占位行，不参与预演） */
interface HopView {
  id: string
  /** 跳序号（在全部行中的位置，从 1 开始），用于明确定位 */
  index: number
  empty: boolean
  error: string | null
  value: number | null
}

function deviceLabel(row: HostRow): string {
  const name = row.assignment.name || '未命名设备'
  const seg = row.segment
  return `${name}（${intToIp(row.assignment.address)} · ${seg ? `${seg.name} ${seg.cidr}` : '—'}）`
}

/** 一跳（或原始报文）的分片表 */
function FragTable({ fragments }: { fragments: Fragment[] }) {
  return (
    <div className="table-scroll">
      <table className="frag-table">
        <thead>
          <tr>
            <th>片序</th>
            <th>负载范围（相对原始负载）</th>
            <th>总长度（含 20 字节首部）</th>
            <th>偏移量（8 字节单位）</th>
            <th>MF</th>
          </tr>
        </thead>
        <tbody>
          {fragments.map((f, i) => (
            <tr key={i}>
              <td className="mono frag-idx">#{i + 1}</td>
              <td className="mono">
                {f.start} ~ {f.end - 1}
                <span className="frag-len">（{f.end - f.start} 字节）</span>
              </td>
              <td className="mono">{fragmentTotalLength(f)}</td>
              <td className="mono">
                {fragmentOffsetUnits(f)}
                <span className="frag-byte-offset">（字节 {f.start}）</span>
              </td>
              <td className="mono">
                {f.mf ? <span className="frag-mf">1</span> : <span className="frag-mf-zero">0</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * IPv4 路径分片预演面板（⑫）：
 * 从当前有效主机登记选择发送设备，给定负载字节数、DF 开关与按经过顺序的 1 ~ 8 跳 MTU，
 * 逐跳预演固定 20 字节首部（无选项）IPv4 报文的分片过程。纯本地计算，只读规划与登记。
 */
export default function FragmentPanel({
  result,
  assignments,
  deviceId,
  payload,
  df,
  hops,
  onDeviceChange,
  onPayloadChange,
  onDfChange,
  onHopsChange,
}: Props) {
  const invalid = result.inputErrors.length > 0

  // 当前有效的主机登记（发送设备候选）；登记或规划变化时实时重算
  const { rows: hostRows } = useMemo(
    () => reconcileHosts(assignments, result),
    [assignments, result],
  )
  const validDevices = hostRows.filter((r) => r.valid)
  const selected = validDevices.find((r) => r.assignment.id === deviceId) ?? null
  // 已选择的设备失效（越界/网络/广播/重复/孤儿/已删除）：保留选择与输入，暂停预演
  const deviceMissing = !invalid && deviceId !== '' && !selected
  const missingAssignment = assignments.find((a) => a.id === deviceId) ?? null

  // 负载字节数：空白 = 未填写（提示）；有内容但非法 = 字段错误（定位并暂停）
  const payloadParsed = useMemo(
    () => (payload.trim() === '' ? null : parsePayloadBytes(payload)),
    [payload],
  )
  const payloadError = payloadParsed !== null && 'error' in payloadParsed ? payloadParsed.error : null
  const payloadValue = payloadParsed !== null && 'value' in payloadParsed ? payloadParsed.value : null

  // 逐跳 MTU 校验视图
  const hopViews: HopView[] = useMemo(
    () =>
      hops.map((h, i) => {
        const text = h.mtu.trim()
        if (text === '') {
          return { id: h.id, index: i + 1, empty: true, error: null, value: null }
        }
        const parsed = parseMtu(text)
        return 'error' in parsed
          ? { id: h.id, index: i + 1, empty: false, error: parsed.error, value: null }
          : { id: h.id, index: i + 1, empty: false, error: null, value: parsed.value }
      }),
    [hops],
  )
  const hopErrorCount = hopViews.filter((v) => v.error !== null).length
  const effectiveMtus = useMemo(
    () => hopViews.filter((v) => !v.empty && v.error === null).map((v) => v.value as number),
    [hopViews],
  )

  // 任一输入非法（负载 / 任一跳 MTU）即暂停预演；设备失效、规划输入非法同样暂停
  const canSimulate =
    !invalid &&
    selected !== null &&
    payloadValue !== null &&
    hopErrorCount === 0 &&
    effectiveMtus.length >= 1

  const sim = useMemo(
    () =>
      canSimulate && payloadValue !== null
        ? simulateFragmentation(payloadValue, df, effectiveMtus)
        : null,
    [canSimulate, payloadValue, df, effectiveMtus],
  )

  function patchHop(id: string, mtu: string) {
    onHopsChange(hops.map((h) => (h.id === id ? { ...h, mtu } : h)))
  }
  function removeHop(id: string) {
    onHopsChange(hops.filter((h) => h.id !== id))
  }
  function addHop() {
    if (hops.length >= MAX_HOPS) return
    onHopsChange([...hops, { id: hopUid(), mtu: '' }])
  }

  return (
    <div className="panel frag-panel">
      <h2>⑫ IPv4 路径分片预演</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        从<strong>当前有效主机登记</strong>中选择发送设备，输入<strong>负载字节数</strong>（
        {MIN_PAYLOAD_BYTES} ~ {MAX_PAYLOAD_BYTES}）、<strong>DF 开关</strong>与按经过顺序排列的
        <strong> 1 ~ {MAX_HOPS} 跳 MTU</strong>（{MIN_MTU} ~ {MAX_MTU} 整数），逐跳预演固定
        <strong> 20 字节首部、无选项</strong>的 IPv4 报文分片过程（纯本地计算）。
        每跳处理上一跳的全部分片：总长度不超过 MTU 则原样通过；DF=1 时超长即报告<strong>首个阻断跳</strong>并停止；
        DF=0 时按不超过 MTU 的最大负载拆分（除原始报文最后一片外负载均为 8 的倍数）。
        后续跳可再次分片但<strong>不重组</strong>；偏移量始终相对原始负载、以 8 字节计，
        MF 仅在该片之后仍有原始数据时为 1。登记或规划变化实时重算；设备失效时保留选择与输入并暂停。
      </p>

      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），路径分片预演已暂停；设备选择与全部输入均已保留，修正后自动重算。
        </div>
      )}
      {!invalid && validDevices.length === 0 && (
        <div className="summary-disabled-note">
          当前没有有效的主机登记，暂无可选的发送设备；请先在「⑥ 主机地址分配」登记有效设备。
        </div>
      )}
      {deviceMissing && (
        <div className="summary-disabled-note">
          已选择的发送设备
          {missingAssignment
            ? `“${missingAssignment.name || '未命名设备'}”（${intToIp(missingAssignment.address)}）`
            : ''}
          在当前登记中已失效（被删除或不再合法），预演已暂停；设备选择与全部输入均已保留，恢复有效登记或重新选择后自动重算。
        </div>
      )}

      <div className="frag-form">
        <div className="frag-device-row">
          <label className="field-label" htmlFor="frag-device">
            发送设备（仅列出当前有效的主机登记）
          </label>
          <select
            id="frag-device"
            className="opt121-select"
            value={deviceId}
            onChange={(e) => onDeviceChange(e.target.value)}
            disabled={invalid || validDevices.length === 0}
          >
            <option value="">— 请选择发送设备 —</option>
            {validDevices.map((row) => (
              <option key={row.assignment.id} value={row.assignment.id}>
                {deviceLabel(row)}
              </option>
            ))}
            {deviceMissing && (
              <option value={deviceId} disabled>
                {missingAssignment
                  ? `${missingAssignment.name || '未命名设备'}（${intToIp(missingAssignment.address)} · 已失效）`
                  : '（已删除的设备，保留选择）'}
              </option>
            )}
          </select>
        </div>

        <div className="frag-payload-row">
          <div className={`frag-payload-field${payloadError ? ' has-error' : ''}`}>
            <label className="field-label" htmlFor="frag-payload">
              负载字节数（{MIN_PAYLOAD_BYTES} ~ {MAX_PAYLOAD_BYTES}，不含 20 字节首部）
            </label>
            <input
              id="frag-payload"
              type="text"
              placeholder={`如 4000（${MIN_PAYLOAD_BYTES} ~ ${MAX_PAYLOAD_BYTES} 的整数）`}
              value={payload}
              onChange={(e) => onPayloadChange(e.target.value)}
            />
            {payloadError && <div className="host-form-error">负载字节数：{payloadError}</div>}
          </div>
          <label className="frag-df-toggle" title="Don't Fragment：置 1 时禁止分片，任一报文超长即在首个阻断跳停止">
            <input
              type="checkbox"
              checked={df}
              onChange={(e) => onDfChange(e.target.checked)}
            />
            <span>
              DF=1（Don't Fragment）
              <em>禁止分片，超长即阻断</em>
            </span>
          </label>
        </div>

        <div className="frag-hops">
          <div className="frag-hops-head">
            <span className="field-label" style={{ marginBottom: 0 }}>
              路径 MTU（按经过顺序，{MIN_MTU} ~ {MAX_MTU}；空白行为占位行，不参与预演）
            </span>
            <span className="frag-hops-count mono">
              有效 {effectiveMtus.length} 跳 / 共 {hops.length} 行（最多 {MAX_HOPS} 跳）
            </span>
          </div>
          {hops.length === 0 && (
            <p className="summary-empty">尚未添加任何跳，请点击下方「+ 添加一跳」。</p>
          )}
          <div className="frag-hop-rows">
            {hops.map((hop, i) => {
              const view = hopViews[i]
              return (
                <div
                  key={hop.id}
                  className={`frag-hop-input${view?.error ? ' has-error' : ''}${view?.empty ? ' is-empty' : ''}`}
                >
                  <div className="frag-hop-input-row">
                    <span className="opt121-idx mono">#{view?.index ?? i + 1}</span>
                    <input
                      type="text"
                      placeholder={`第 ${i + 1} 跳 MTU，如 1500（${MIN_MTU} ~ ${MAX_MTU}）`}
                      value={hop.mtu}
                      onChange={(e) => patchHop(hop.id, e.target.value)}
                    />
                    <button
                      type="button"
                      className="icon"
                      title="删除该跳"
                      onClick={() => removeHop(hop.id)}
                    >
                      ✕
                    </button>
                  </div>
                  {view?.error && (
                    <div className="host-form-error frag-hop-error">
                      第 {view.index} 跳：{view.error}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button onClick={addHop} disabled={hops.length >= MAX_HOPS}>
              + 添加一跳
            </button>
            {hops.length >= MAX_HOPS && (
              <span className="hint-warn">已达 {MAX_HOPS} 跳上限</span>
            )}
          </div>
        </div>
      </div>

      {!invalid && !deviceMissing && deviceId === '' && validDevices.length > 0 && (
        <p className="summary-empty">请选择发送设备后开始预演。</p>
      )}
      {!invalid && selected && payloadValue === null && !payloadError && (
        <p className="summary-empty">请输入负载字节数（{MIN_PAYLOAD_BYTES} ~ {MAX_PAYLOAD_BYTES}）。</p>
      )}
      {!invalid && selected && payloadValue !== null && effectiveMtus.length === 0 && hopErrorCount === 0 && (
        <p className="summary-empty">请至少填写 1 跳 MTU（{MIN_MTU} ~ {MAX_MTU} 的整数）。</p>
      )}
      {hopErrorCount > 0 && (
        <div className="opt121-error-box">
          <strong>存在 {hopErrorCount} 处 MTU 录入错误，已暂停预演（错误位置见上方对应跳）：</strong>
          <ul>
            {hopViews
              .filter((v) => v.error !== null)
              .map((v) => (
                <li key={v.id}>
                  第 {v.index} 跳：{v.error}
                </li>
              ))}
          </ul>
        </div>
      )}

      {sim && selected && (
        <div className="frag-result">
          <div className="frag-meta-row">
            <span className="rdns-chip">
              发送设备 <strong>{selected.assignment.name || '未命名设备'}</strong>
            </span>
            <span className="rdns-chip mono">{intToIp(selected.assignment.address)}</span>
            {selected.segment && (
              <span className="rdns-chip mono">
                {selected.segment.name} {selected.segment.cidr}
              </span>
            )}
            <span className="rdns-chip">
              负载 <strong>{sim.payloadBytes}</strong> 字节
            </span>
            <span className="rdns-chip">
              DF=<strong>{sim.df ? 1 : 0}</strong>
            </span>
            <span className="rdns-chip">
              路径 <strong>{sim.hops.length}</strong> 跳
              {sim.blockedHop !== null && effectiveMtus.length > sim.hops.length
                ? `（共 ${effectiveMtus.length} 跳，阻断后未评估）`
                : ''}
            </span>
          </div>

          <div className="frag-hop">
            <div className="frag-hop-head">
              <span className="frag-hop-title">原始报文（发送前）</span>
              <span className="frag-hop-meta">
                1 片 · 总长度 {IPV4_HEADER_BYTES + sim.payloadBytes} 字节
              </span>
            </div>
            <FragTable fragments={sim.initial} />
          </div>

          {sim.hops.map((hop) => (
            <div className={`frag-hop${hop.blocked ? ' is-blocked' : ''}`} key={hop.hop}>
              <div className="frag-hop-head">
                <span className="frag-hop-title">
                  第 {hop.hop} 跳 · MTU {hop.mtu}
                </span>
                <span className="frag-hop-meta">
                  {hop.blocked
                    ? '✖ 阻断（DF=1）'
                    : hop.split
                      ? `拆分 → ${hop.fragments.length} 片`
                      : `原样通过（${hop.fragments.length} 片）`}
                </span>
              </div>
              {hop.blocked && (
                <div className="frag-blocked-note">
                  报文总长度 {hop.blockedTotalLength} 字节超过本跳 MTU {hop.mtu}，且 DF=1
                  禁止分片：第 {hop.hop} 跳为首个阻断跳，预演在此停止。
                </div>
              )}
              <FragTable fragments={hop.fragments} />
            </div>
          ))}

          {sim.blockedHop !== null && effectiveMtus.length > sim.blockedHop && (
            <p className="frag-not-reached">
              第 {sim.blockedHop + 1} ~ {effectiveMtus.length} 跳未到达（预演已在首个阻断跳停止）。
            </p>
          )}

          <div className="frag-stats-row">
            <span className="rdns-chip">
              {sim.blockedHop !== null ? '阻断前片数' : '最终片数'}{' '}
              <strong>{sim.finalFragments.length}</strong>
            </span>
            <span className="rdns-chip">
              首部开销 <strong>{sim.headerBytes}</strong> 字节（{IPV4_HEADER_BYTES} ×{' '}
              {sim.finalFragments.length}）
            </span>
            <span className="rdns-chip">
              线路总字节 <strong>{sim.payloadBytes + sim.headerBytes}</strong>（负载 + 首部）
            </span>
            {sim.blockedHop === null && (
              <span className="rdns-chip">
                分片发生 <strong>{sim.hops.filter((h) => h.split).length}</strong> 跳
              </span>
            )}
            {sim.blockedHop !== null && (
              <span className="rdns-chip frag-chip-blocked">统计截至阻断前</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
