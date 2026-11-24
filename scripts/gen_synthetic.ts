// 命令行合成 RVF 样本文件：pnpm gen-data
// 产出 sample_data/ 下若干 .rvf，可在数据管理页直接导入
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSyntheticVolume } from '../src/core/synthetic_gen'
import { writeRvf } from '../src/core/rvf_format'
import type { ScenarioKind } from '../src/core/synthetic_scene'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'sample_data')
mkdirSync(outDir, { recursive: true })

const baseTime = new Date('2026-06-25T08:00:00.000Z').toISOString()
const scenarios: { kind: ScenarioKind; frames: number; label: string }[] = [
  { kind: 'supercell', frames: 12, label: 'supercell' },
  { kind: 'squall', frames: 6, label: 'squall' },
  { kind: 'broken', frames: 1, label: 'broken' },
]

let total = 0
for (const scenario of scenarios) {
  for (let i = 0; i < scenario.frames; i++) {
    const offsetMin = (i - scenario.frames + 1) * 6
    const drop =
      scenario.kind === 'broken' ? [3, 7, 14] : undefined
    const { volume } = generateSyntheticVolume({
      kind: scenario.kind,
      stationId: 'Z9871',
      baseTimeIso: baseTime,
      timeOffsetMin: offsetMin,
      dropElevationIndices: drop,
      seed: 20260625 + total * 101,
    })
    const buf = writeRvf(volume)
    const stamp = volume.meta.scanTimeIso.replace(/[:.]/g, '-')
    const file = join(outDir, `${scenario.label}_${stamp}.rvf`)
    writeFileSync(file, Buffer.from(buf))
    total++
    console.log(
      `写出 ${file} 仰角=${volume.sweeps.length} 大小=${(buf.byteLength / 1024 / 1024).toFixed(2)}MB`,
    )
  }
}
console.log(`完成，共 ${total} 个 RVF 样本 -> ${outDir}`)
