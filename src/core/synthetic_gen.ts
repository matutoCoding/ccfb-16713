import { encodeDbz, encodeVel, encodeWidth, MISSING_U8 } from './codec'
import { beamPosition } from './geometry'
import { DeterministicRandom } from './random'
import { STANDARD_ELEVATIONS_20 } from './rvf_format'
import {
  SYNTH_STATION,
  SUPERCELL_TRUTH,
  SQUALL_TRUTH,
  makeClutterMap,
  clutterContribution,
  type ScenarioConfig,
} from './synthetic_scene'
import { SquallLineModel, SupercellModel, type StormModel } from './storm_model'
import type {
  ClutterMap,
  FieldType,
  GroundTruth,
  RadarRay,
  RadarVolume,
  Sweep,
  VolumeMeta,
} from './types'

const FIELDS: FieldType[] = ['dbz', 'vel', 'width']

// 随时间演进的风暴位置：单体沿移向移动，飑线缓慢平移
function buildModels(cfg: ScenarioConfig): { models: StormModel[]; truth: GroundTruth } {
  const t = cfg.timeOffsetMin
  const moveRad = (SUPERCELL_TRUTH.moveDirDeg * Math.PI) / 180
  const drift = SUPERCELL_TRUTH.moveSpeed * 60 * t
  const cellCx = SUPERCELL_TRUTH.cx + Math.sin(moveRad) * drift
  const cellCy = SUPERCELL_TRUTH.cy + Math.cos(moveRad) * drift

  const models: StormModel[] = []
  const cores: GroundTruth['cores'] = []

  if (cfg.kind === 'supercell' || cfg.kind === 'mixed' || cfg.kind === 'broken') {
    const model = new SupercellModel(cfg.seed + 1, {
      cx: cellCx,
      cy: cellCy,
      moveDirDeg: SUPERCELL_TRUTH.moveDirDeg,
      moveSpeed: SUPERCELL_TRUTH.moveSpeed,
      maxDbz: SUPERCELL_TRUTH.maxDbz,
    })
    models.push(model)
    // 真值来自模型解析峰值（含悬垂倾斜），与重采样算法完全独立
    const peak = model.analyticPeak()
    cores.push({
      name: '超级单体主核',
      kind: 'supercell',
      xM: peak.xM,
      yM: peak.yM,
      zM: peak.zM,
      peakDbz: peak.peakDbz,
    })
  }

  if (cfg.kind === 'squall' || cfg.kind === 'mixed') {
    const lineDrift = 8 * 60 * t
    const lineRad = ((SQUALL_TRUTH.angleDeg + 90) * Math.PI) / 180
    const model = new SquallLineModel(cfg.seed + 2, {
      angleDeg: SQUALL_TRUTH.angleDeg,
      cx: SQUALL_TRUTH.cx + Math.sin(lineRad) * lineDrift,
      cy: SQUALL_TRUTH.cy + Math.cos(lineRad) * lineDrift,
      lengthM: SQUALL_TRUTH.lengthM,
      widthM: SQUALL_TRUTH.widthM,
      maxDbz: SQUALL_TRUTH.maxDbz,
    })
    models.push(model)
    const peak = model.analyticPeak()
    cores.push({
      name: '飑线强回波带',
      kind: 'squall',
      xM: peak.xM,
      yM: peak.yM,
      zM: peak.zM,
      peakDbz: peak.peakDbz,
    })
  }

  const desc =
    cfg.kind === 'broken'
      ? '缺仰角的超级单体场景（测试不完整文件容错）'
      : cfg.kind === 'mixed'
        ? '超级单体与飑线共存的混合对流场景'
        : cfg.kind === 'squall'
          ? '准线性飑线对流场景'
          : '经典超级单体（含悬垂与有界弱回波区）'
  return { models, truth: { cores, description: desc } }
}

// 合成一个完整（或缺仰角）的体扫
export function generateSyntheticVolume(cfg: ScenarioConfig): {
  volume: RadarVolume
  clutter: ClutterMap[]
} {
  const { models, truth } = buildModels(cfg)
  const rng = new DeterministicRandom(cfg.seed * 7919 + 13)
  const station = SYNTH_STATION
  const gateM = station.rangeM / station.gateCount
  const clutter: ClutterMap[] = []

  const dropSet = new Set(cfg.dropElevationIndices ?? [])
  const sweeps: Sweep[] = []

  STANDARD_ELEVATIONS_20.forEach((elevationDeg, elevIdx) => {
    if (dropSet.has(elevIdx)) return
    const clutterMap = makeClutterMap(
      station.stationId,
      elevationDeg,
      station.azimuthCount,
      station.gateCount,
      cfg.seed,
    )
    clutter.push(clutterMap)
    const rays: RadarRay[] = []

    for (let az = 0; az < station.azimuthCount; az++) {
      const azimuthDeg = az + 0.5
      const arrays = Object.fromEntries(
        FIELDS.map((f) => [f, new Uint8Array(station.gateCount)]),
      ) as Record<FieldType, Uint8Array>

      for (let g = 0; g < station.gateCount; g++) {
        const slant = (g + 0.5) * gateM
        const { groundRangeM, altitudeM } = beamPosition(
          slant,
          elevationDeg,
          station.altitudeM,
        )
        const azRad = (azimuthDeg * Math.PI) / 180
        const x = groundRangeM * Math.sin(azRad)
        const y = groundRangeM * Math.cos(azRad)
        const z = altitudeM + station.altitudeM

        // 叠加所有风暴模型，取最强回波
        let best = { dbz: NaN, vel: NaN, width: NaN }
        for (const model of models) {
          const s = model.sample(x, y, z)
          if (!Number.isNaN(s.dbz) && (Number.isNaN(best.dbz) || s.dbz > best.dbz)) best = s
        }

        // 地物杂波只在最低两层生效
        if (elevIdx <= 1) {
          const c = clutterContribution(
            clutterMap.flags,
            az,
            g,
            station.gateCount,
          )
          if (c && (Number.isNaN(best.dbz) || c.dbz > best.dbz)) best = c
        }

        if (Number.isNaN(best.dbz)) {
          arrays.dbz[g] = MISSING_U8
          arrays.vel[g] = MISSING_U8
          arrays.width[g] = MISSING_U8
          continue
        }

        // 测量噪声
        const noisyDbz = best.dbz + rng.gaussian() * 0.8
        const noisyVel = best.vel + rng.gaussian() * 0.6
        const noisyWidth = Math.max(0.2, best.width + rng.gaussian() * 0.3)
        arrays.dbz[g] = encodeDbz(noisyDbz)
        arrays.vel[g] = encodeVel(noisyVel, station.nyquistMps)
        arrays.width[g] = encodeWidth(noisyWidth)
      }

      rays.push({
        azimuthDeg,
        elevationDeg,
        startRangeM: 0,
        gateWidthM: gateM,
        fields: arrays,
      })
    }

    sweeps.push({ elevationDeg, rays })
  })

  const scanTime = new Date(new Date(cfg.baseTimeIso).getTime() + cfg.timeOffsetMin * 60000)
  const rayCount = sweeps.reduce((n, s) => n + s.rays.length, 0)
  const meta: VolumeMeta = {
    id: '',
    stationId: station.stationId,
    scanTimeIso: scanTime.toISOString(),
    elevationCount: sweeps.length,
    expectedElevationCount: station.expectedElevations,
    missingElevations: STANDARD_ELEVATIONS_20.filter(
      (_, i) => dropSet.has(i),
    ).map((e) => e),
    rayCount,
    gateCount: station.gateCount,
    rangeM: station.rangeM,
    nyquistMps: station.nyquistMps,
    lat: station.lat,
    lon: station.lon,
    altitudeM: station.altitudeM,
    sizeBytes: 0,
    hasGroundTruth: true,
    note: cfg.kind,
  }

  return {
    volume: { meta, sweeps, groundTruth: truth },
    clutter,
  }
}
