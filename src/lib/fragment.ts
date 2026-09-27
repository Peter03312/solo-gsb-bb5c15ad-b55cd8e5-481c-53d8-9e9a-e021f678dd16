// IPv4 路径分片预演：单个 IPv4 报文沿给定 MTU 路径逐跳转发时的分片过程。
// 本模块只做本地纯计算，只读取面板录入，绝不修改规划、基线、路由汇总、主机登记与导出。
//
// 模型约定（固定 IPv4 首部 20 字节、无选项）：
//   - 原始报文 = 20 字节首部 + P 字节负载（1 ≤ P ≤ 65515，保证总长度 ≤ 65535）；
//   - 每一跳处理上一跳输出的全部分片：总长度（20 + 负载）不超过该跳 MTU 则原样通过；
//   - DF=1 时任何报文超长即报告首个阻断跳并停止整个预演（DF=1 时永不拆分，
//     因此阻断一定发生在原始报文上）；
//   - DF=0 时把超长片拆成「不超过 MTU 的最大负载」：每片负载取 floor((MTU-20)/8)*8
//     字节（MTU ≥ 68 保证该值 ≥ 48），除原始报文最后一片外，每片负载都是 8 的倍数；
//   - 后续跳可对已有分片再次拆分，但绝不重组（更大 MTU 的后续跳不会合并分片）；
//   - 片偏移始终相对原始负载、以 8 字节为单位（所有片的起点都是 8 的倍数，见下）；
//   - MF=1 当且仅当该片之后仍有原始数据（等价于该片终点 < 原始负载末尾）。
//
// 不变量（对任意合法输入成立）：
//   1. 任一时刻全部片按起点升序、互不重叠地覆盖 [0, P)；
//   2. 每片起点都是 8 的倍数（起点 = 上一片起点 + 8 的倍数，归纳成立），故片偏移恒为整数；
//   3. 除终点 = P 的最后一片外，每片负载长度都是 8 的倍数（非最后一片被再拆分时，
//      其长度与拆分粒度同为 8 的倍数，余数仍是 8 的倍数）。

/** 固定 IPv4 首部长度（无选项） */
export const IPV4_HEADER_BYTES = 20
/** 负载字节数下限 */
export const MIN_PAYLOAD_BYTES = 1
/** 负载字节数上限：65535（总长度上限）− 20（首部） */
export const MAX_PAYLOAD_BYTES = 65535 - IPV4_HEADER_BYTES
/** 单跳 MTU 下限（IPv4 规定链路至少支持 68 字节） */
export const MIN_MTU = 68
/** 单跳 MTU 上限（不超过 IPv4 总长度字段可表达的最大值） */
export const MAX_MTU = 65535
/** 路径跳数上限 */
export const MAX_HOPS = 8

/** 一个分片：负载区间相对原始负载（终点不含），MF 表示其后仍有原始数据 */
export interface Fragment {
  /** 负载起点（相对原始负载的字节偏移，含；恒为 8 的倍数） */
  start: number
  /** 负载终点（相对原始负载的字节偏移，不含） */
  end: number
  /** More Fragments：该片之后仍有原始数据时为 true */
  mf: boolean
}

/** 一跳的预演结果 */
export interface FragHopResult {
  /** 跳序号（从 1 开始，按经过顺序） */
  hop: number
  mtu: number
  /** 本跳处理后的分片列表（阻断时为试图通过本跳、即上一跳输出的分片） */
  fragments: Fragment[]
  /** 本跳是否发生了拆分 */
  split: boolean
  /** DF=1 且报文总长度超过本跳 MTU：首个阻断跳，预演在此停止 */
  blocked: boolean
  /** 阻断时首个超长报文的总长度（含 20 字节首部） */
  blockedTotalLength?: number
}

export interface FragSimulation {
  payloadBytes: number
  df: boolean
  /** 原始报文（发送前，恒为 1 片） */
  initial: Fragment[]
  /** 逐跳结果（含阻断跳；阻断后不再评估后续跳） */
  hops: FragHopResult[]
  /** 首个阻断跳序号（1 起）；未阻断为 null */
  blockedHop: number | null
  /** 预演结束时的分片（阻断时为阻断跳之前、即试图通过阻断跳的分片） */
  finalFragments: Fragment[]
  /** 首部开销合计 = 20 × 最终片数 */
  headerBytes: number
}

/** 解析负载字节数：1 ~ 65515 的整数；返回错误文本或数值 */
export function parsePayloadBytes(raw: string): { value: number } | { error: string } {
  const text = raw.trim()
  if (!text) return { error: '请输入负载字节数' }
  if (!/^\d+$/.test(text)) {
    return { error: `“${text}”不是正整数，负载字节数需为 ${MIN_PAYLOAD_BYTES} ~ ${MAX_PAYLOAD_BYTES} 的整数` }
  }
  const value = Number(text)
  if (value < MIN_PAYLOAD_BYTES || value > MAX_PAYLOAD_BYTES) {
    return {
      error: `负载字节数需在 ${MIN_PAYLOAD_BYTES} ~ ${MAX_PAYLOAD_BYTES} 之间（首部 20 字节 + 负载不得超过 65535），当前为 ${value}`,
    }
  }
  return { value }
}

/** 解析单跳 MTU：68 ~ 65535 的整数；返回错误文本或数值 */
export function parseMtu(raw: string): { value: number } | { error: string } {
  const text = raw.trim()
  if (!text) return { error: '请输入 MTU' }
  if (!/^\d+$/.test(text)) {
    return { error: `“${text}”不是正整数，MTU 需为 ${MIN_MTU} ~ ${MAX_MTU} 的整数` }
  }
  const value = Number(text)
  if (value < MIN_MTU || value > MAX_MTU) {
    return { error: `MTU 需在 ${MIN_MTU} ~ ${MAX_MTU} 之间，当前为 ${value}` }
  }
  return { value }
}

/** 分片负载长度（字节） */
export function fragmentLength(f: Fragment): number {
  return f.end - f.start
}

/** 分片总长度（含 20 字节首部） */
export function fragmentTotalLength(f: Fragment): number {
  return IPV4_HEADER_BYTES + fragmentLength(f)
}

/** 片偏移（相对原始负载，以 8 字节为单位；起点恒为 8 的倍数故恒为整数） */
export function fragmentOffsetUnits(f: Fragment): number {
  return f.start / 8
}

/**
 * 逐跳预演。mtus 必须已通过 parseMtu 校验（68 ~ 65535），payloadBytes 已通过
 * parsePayloadBytes 校验（1 ~ 65515）；调用方负责在校验失败时暂停预演。
 */
export function simulateFragmentation(
  payloadBytes: number,
  df: boolean,
  mtus: number[],
): FragSimulation {
  const initial: Fragment[] = [{ start: 0, end: payloadBytes, mf: false }]
  let current = initial
  const hops: FragHopResult[] = []
  let blockedHop: number | null = null

  for (let i = 0; i < mtus.length; i++) {
    const mtu = mtus[i]
    const hop = i + 1

    if (df) {
      // DF=1：永不拆分，任一报文超长即阻断并停止（此时只可能是原始报文）
      const oversized = current.find((f) => fragmentTotalLength(f) > mtu)
      if (oversized) {
        hops.push({
          hop,
          mtu,
          fragments: current,
          split: false,
          blocked: true,
          blockedTotalLength: fragmentTotalLength(oversized),
        })
        blockedHop = hop
        break
      }
      hops.push({ hop, mtu, fragments: current, split: false, blocked: false })
      continue
    }

    // DF=0：逐片检查，超长片按「不超过 MTU 的最大 8 字节倍数负载」拆分
    // MTU ≥ 68 ⇒ chunk ≥ 48，下面的拆分循环必然前进，不会死循环
    const chunk = Math.floor((mtu - IPV4_HEADER_BYTES) / 8) * 8
    const next: Fragment[] = []
    let split = false
    for (const f of current) {
      if (fragmentTotalLength(f) <= mtu) {
        next.push(f)
        continue
      }
      split = true
      let pos = f.start
      while (pos < f.end) {
        const take = Math.min(chunk, f.end - pos)
        // 本片之后仍有原始数据（未拆完本片，或本片原本就不是最后一片）时 MF=1
        next.push({ start: pos, end: pos + take, mf: pos + take < f.end ? true : f.mf })
        pos += take
      }
    }
    hops.push({ hop, mtu, fragments: next, split, blocked: false })
    current = next
  }

  const finalFragments = current
  return {
    payloadBytes,
    df,
    initial,
    hops,
    blockedHop,
    finalFragments,
    headerBytes: IPV4_HEADER_BYTES * finalFragments.length,
  }
}
