import type { RimMode } from '@meniscus/core'
import type { PopoverPlacement } from '@meniscus/presets'
import type { LabId, OpticsViewMode } from './labDefaults.ts'

export type Locale = 'en' | 'zh'

export const LOCALE_STORAGE_KEY = 'meniscus-playground-locale'

export interface LocaleDetectionEnv {
  storage?: Pick<Storage, 'getItem'> | null
  navigatorLanguage?: string | null
}

/**
 * Resolves the initial playground locale from persisted preference or browser language,
 * remaining safe under SSR and restricted storage environments.
 */
export function detectInitialLocale(env?: LocaleDetectionEnv): Locale {
  let stored: string | null = null
  try {
    const storage =
      env && 'storage' in env
        ? env.storage
        : typeof globalThis !== 'undefined' && 'localStorage' in globalThis
          ? globalThis.localStorage
          : null
    stored = storage?.getItem(LOCALE_STORAGE_KEY) ?? null
  } catch {
    stored = null
  }

  if (stored === 'en' || stored === 'zh') {
    return stored
  }

  const rawLang =
    env && 'navigatorLanguage' in env
      ? env.navigatorLanguage
      : typeof navigator !== 'undefined'
        ? navigator.language
        : null

  if (typeof rawLang === 'string' && rawLang.toLowerCase().startsWith('zh')) {
    return 'zh'
  }
  return 'en'
}

export function persistLocale(locale: Locale): void {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    }
  } catch {
    // Ignore storage write errors in private or sandboxed contexts.
  }
}

export interface PlaygroundMessages {
  documentTitle: string
  header: {
    subtitle: string
    refractSupported: string
    frostedFallback: string
    overlayWebgl2: string
    overlayCanvas2d: string
    themeLight: string
    themeDark: string
    reducedMotionOn: string
    reducedMotionOff: string
    langToggleLabel: string
    langToggleAria: string
    labsNavAria: string
  }
  tabs: Record<LabId, { title: string; description: string }>
  backdrop: {
    kicker: string
    pulsesPrefix: string
    mutateButton: string
  }
  dragMerge: {
    backdropTitle: string
    backdropCaption: string
    nodes: Record<'anchor' | 'orb-a' | 'orb-b' | 'pill-c', { label: string; sublabel: string }>
    extraNodeLabelPrefix: string
    extraNodeSublabel: string
    panelTitle: string
    panelDescription: string
    blendKLabel: string
    magneticRadiusLabel: string
    returnOnRelease: string
    snapNearest: string
    addDroplet: string
    remove: string
    reset: string
    statPrimitives: string
    statBridges: string
    statClosestPair: string
    statSurfaceGap: string
    nonePair: string
  }
  segmentedDock: {
    backdropTitle: string
    backdropCaption: string
    dockAriaLabel: string
    segments: Record<'overview' | 'optics' | 'field' | 'motion' | 'export', string>
    panelTitle: string
    panelDescription: string
    horizontal: string
    vertical: string
    blendKLabel: string
    maxStretchLabel: string
    squeezeLabel: string
    retargetButton: string
    statActiveTab: string
    statLobes: string
    statStretch: string
    statMotion: string
    motionFlowing: string
    motionSettled: string
  }
  optics: {
    backdropTitle: string
    backdropCaption: string
    splitLeftBadge: string
    splitLeftTitle: string
    splitLeftCaption: string
    splitRightBadge: string
    splitRightTitle: string
    splitRightCaption: string
    panelTitle: string
    panelDescription: string
    views: Record<OpticsViewMode, string>
    gapLabel: string
    blendKLabel: string
    bevelLabel: string
    strengthLabel: string
    dispersionLabel: string
    blurLabel: string
    saturationLabel: string
    rimOpacityLabel: string
    rimPrefix: string
    rimModes: Record<RimMode, string>
    wireframeButton: string
    oscillateButton: string
    resetButton: string
    statEffectiveTier: string
    statGapOffset: string
    liveSuffix: string
    tierLabels: {
      refract: string
      frosted: string
      solid: string
      split: string
      splitDowngraded: string
      refractDowngraded: string
    }
  }
  popoverMenu: {
    backdropTitle: string
    backdropCaption: string
    triggerLabel: string
    menuAriaLabel: string
    menuItems: Record<'refract-preset' | 'smin-fuse' | 'interrupt' | 'edge-flip', string>
    contextHint: string
    contextHereButton: string
    panelTitle: string
    panelDescription: string
    placements: Record<PopoverPlacement, string>
    externalTrigger: string
    bareSource: string
    interruptDemo: string
    closeMenu: string
    statPhase: string
    statSourceMode: string
    statLastAction: string
    statReducedMotion: string
    phases: Record<'closed' | 'opening' | 'open' | 'closing', string>
    sourceModes: Record<'anchored' | 'point', string>
    reducedMotionMode: string
    springMode: string
    noneAction: string
  }
}

export const MESSAGES: Record<Locale, PlaygroundMessages> = {
  en: {
    documentTitle: 'Meniscus — Live-DOM Glass Morphing Laboratory',
    header: {
      subtitle: 'Live-DOM N-Primitive Continuous Glass Morphing Laboratory',
      refractSupported: 'Refract (Chromium Route B3)',
      frostedFallback: 'Frosted Fallback (Non-Chromium)',
      overlayWebgl2: 'WebGL2',
      overlayCanvas2d: 'Canvas 2D',
      themeLight: 'Theme: Light',
      themeDark: 'Theme: Dark',
      reducedMotionOn: 'Reduced Motion: On',
      reducedMotionOff: 'Reduced Motion: Off',
      langToggleLabel: 'Lang: EN',
      langToggleAria: 'Switch language to Simplified Chinese',
      labsNavAria: 'Meniscus Interactive Labs',
    },
    tabs: {
      'drag-merge': {
        title: 'Drag & Merge Lab',
        description: 'Interactive N-primitive liquid bridges & magnetic attraction',
      },
      'segmented-dock': {
        title: 'Morphing Dock',
        description: 'Continuous-flow segmented pill with mid-flight retargeting',
      },
      optics: {
        title: 'Optics & Degradation',
        description: 'Live optical parameters, Route B3 refract vs frosted & SDF contour',
      },
      'popover-menu': {
        title: 'Popover & Context Menu',
        description: 'Interruptible anchored popover & point-origin context menu',
      },
    },
    backdrop: {
      kicker: 'Live DOM Optical Substrate',
      pulsesPrefix: 'Substrate pulses',
      mutateButton: 'Mutate DOM',
    },
    dragMerge: {
      backdropTitle: 'Drag & Merge Liquid Bridges',
      backdropCaption:
        'Drag droplets across swatches or slide them into the pinned anchor to trigger magnetic pull and smin meniscus bridges.',
      nodes: {
        anchor: { label: 'Anchor', sublabel: 'Pinned' },
        'orb-a': { label: 'Orb A', sublabel: 'Drag me' },
        'orb-b': { label: 'Lens B', sublabel: 'Drag me' },
        'pill-c': { label: 'Capsule C', sublabel: 'Drag me' },
      },
      extraNodeLabelPrefix: 'Drop',
      extraNodeSublabel: 'Drag me',
      panelTitle: 'Field & Coupling Controls',
      panelDescription:
        'Tune the smooth-union radius and magnetic pull driving the N-primitive SDF field.',
      blendKLabel: 'Smooth Union (blendK)',
      magneticRadiusLabel: 'Magnetic Capture Radius',
      returnOnRelease: 'Return on Release',
      snapNearest: 'Snap Nearest',
      addDroplet: 'Add Droplet',
      remove: 'Remove',
      reset: 'Reset',
      statPrimitives: 'Primitives',
      statBridges: 'Active Bridges',
      statClosestPair: 'Closest Pair',
      statSurfaceGap: 'Surface Gap',
      nonePair: 'None',
    },
    segmentedDock: {
      backdropTitle: 'Continuous Morphing Dock',
      backdropCaption:
        'Spring-led trailing and leading lobes elongate along travel and collapse cleanly to a crisp single capsule at rest.',
      dockAriaLabel: 'Morphing navigation dock',
      segments: {
        overview: 'Overview',
        optics: 'Optics',
        field: 'SDF Field',
        motion: 'Springs',
        export: 'Spec',
      },
      panelTitle: 'Segmented Flow Parameters',
      panelDescription:
        'Lead/trail differential springs stretch the liquid indicator into two blended primitives only while in motion.',
      horizontal: 'Horizontal',
      vertical: 'Vertical',
      blendKLabel: 'Bridge Blend (blendK)',
      maxStretchLabel: 'Max Separation Clamp',
      squeezeLabel: 'Cross-Axis Squeeze',
      retargetButton: 'Mid-Flight Retarget',
      statActiveTab: 'Active Tab',
      statLobes: 'Lobes Active',
      statStretch: 'Stretch Ratio',
      statMotion: 'Motion',
      motionFlowing: 'Flowing',
      motionSettled: 'Settled',
    },
    optics: {
      backdropTitle: 'Optics & Progressive Degradation',
      backdropCaption:
        'Tune bevel lens width, RGB dispersion, blur, and separation gap over crisp text and spectral swatches.',
      splitLeftBadge: 'Requested: Refract (Route B3)',
      splitLeftTitle: 'Route B3 Lens',
      splitLeftCaption: 'Stored-PNG SDF displacement + chromatic dispersion.',
      splitRightBadge: 'Fallback: Frosted Contour',
      splitRightTitle: 'Frosted Veil',
      splitRightCaption: 'Universal CSS backdrop blur + SDF contour + WebGL2 rim.',
      panelTitle: 'Optical Bench Parameters',
      panelDescription:
        'Inspect Route B3 displacement refraction vs Gaussian frosted fallback and live SDF contours.',
      views: {
        refract: 'Refract',
        frosted: 'Frosted',
        solid: 'Solid',
        split: 'Split Compare',
      },
      gapLabel: 'Primitive Separation',
      blendKLabel: 'Smooth Union (blendK)',
      bevelLabel: 'Bevel Lens Width',
      strengthLabel: 'Refraction Strength',
      dispersionLabel: 'RGB Dispersion',
      blurLabel: 'Gaussian Blur',
      saturationLabel: 'Backdrop Saturation',
      rimOpacityLabel: 'Rim Highlight Opacity',
      rimPrefix: 'Rim',
      rimModes: {
        directional: 'directional',
        soft: 'soft',
      },
      wireframeButton: 'SDF Wireframe',
      oscillateButton: 'Oscillate Gap',
      resetButton: 'Reset Optics',
      statEffectiveTier: 'Effective Tier',
      statGapOffset: 'Gap Offset',
      liveSuffix: '(live)',
      tierLabels: {
        refract: 'refract',
        frosted: 'frosted',
        solid: 'solid',
        split: 'refract + frosted',
        splitDowngraded: 'frosted + frosted',
        refractDowngraded: 'frosted (auto-downgraded)',
      },
    },
    popoverMenu: {
      backdropTitle: 'Production Popover & Context Menu',
      backdropCaption:
        'Click Actions to expand the anchored liquid popover, or right-click anywhere inside the stage for a point context menu.',
      triggerLabel: 'Actions ▾',
      menuAriaLabel: 'Morphing popover actions',
      menuItems: {
        'refract-preset': 'Route B3 Refraction',
        'smin-fuse': 'Smooth Union Bridge',
        interrupt: 'Interrupt Mid-Flight',
        'edge-flip': 'Clamp & Auto-Flip',
      },
      contextHint: 'Right-click stage or spawn at point:',
      contextHereButton: 'Context Menu Here',
      panelTitle: 'Popover & Menu Options',
      panelDescription:
        'Test anchor placements, bare/external triggers, point clamping, and rapid mid-flight reversals.',
      placements: {
        overAnchorEnd: 'overAnchorEnd',
        overAnchorStart: 'overAnchorStart',
        belowPoint: 'belowPoint',
        abovePoint: 'abovePoint',
      },
      externalTrigger: 'External Trigger',
      bareSource: 'Bare Source',
      interruptDemo: 'Interrupt Reversal Demo',
      closeMenu: 'Close Menu',
      statPhase: 'Phase',
      statSourceMode: 'Source Mode',
      statLastAction: 'Last Action',
      statReducedMotion: 'Reduced Motion',
      phases: {
        closed: 'closed',
        opening: 'opening',
        open: 'open',
        closing: 'closing',
      },
      sourceModes: {
        anchored: 'anchored',
        point: 'point',
      },
      reducedMotionMode: 'Crossfade',
      springMode: 'Spring',
      noneAction: 'None',
    },
  },
  zh: {
    documentTitle: 'Meniscus — Live-DOM 连续液态玻璃形变实验室',
    header: {
      subtitle: 'Live-DOM 任意多图元连续玻璃形变与光学实验场',
      refractSupported: '实时折射（Chromium Route B3）',
      frostedFallback: '磨砂降级（非 Chromium 内核）',
      overlayWebgl2: 'WebGL2',
      overlayCanvas2d: 'Canvas 2D',
      themeLight: '主题：浅色',
      themeDark: '主题：深色',
      reducedMotionOn: '减弱动态：开',
      reducedMotionOff: '减弱动态：关',
      langToggleLabel: '语言：中文',
      langToggleAria: 'Switch language to English',
      labsNavAria: 'Meniscus 交互实验室列表',
    },
    tabs: {
      'drag-merge': {
        title: '自由拖拽液桥',
        description: 'N 图元自由拖拽、磁吸捕捉与平滑并集液桥形变',
      },
      'segmented-dock': {
        title: '多态连续导航',
        description: '双弹簧差速胶囊滑块与飞行中途无缝变轨',
      },
      optics: {
        title: '动态折射光学',
        description: '实时光学参数调控、Route B3 折射/磨砂对比与 SDF 轮廓',
      },
      'popover-menu': {
        title: '气泡弹窗与右键菜单',
        description: '可打断锚点展开菜单与视口自适应定点上下文菜单',
      },
    },
    backdrop: {
      kicker: 'Live-DOM 实时光学基底',
      pulsesPrefix: '基底 DOM 计数',
      mutateButton: '更新基底',
    },
    dragMerge: {
      backdropTitle: '自由拖拽与液桥融合',
      backdropCaption:
        '在光谱色块上方拖拽玻璃液滴，或拖近固定锚点以触发邻域磁吸与 smin 连续液桥。',
      nodes: {
        anchor: { label: '锚点', sublabel: '已固定' },
        'orb-a': { label: '液滴 A', sublabel: '拖动我' },
        'orb-b': { label: '透镜 B', sublabel: '拖动我' },
        'pill-c': { label: '胶囊 C', sublabel: '拖动我' },
      },
      extraNodeLabelPrefix: '液滴',
      extraNodeSublabel: '拖动我',
      panelTitle: 'SDF 场与耦合控制',
      panelDescription: '实时调节多图元平滑并集半径、磁吸半径与释放回弹策略。',
      blendKLabel: '平滑融合度（blendK）',
      magneticRadiusLabel: '磁吸捕获半径',
      returnOnRelease: '松手归位',
      snapNearest: '吸附最近节点',
      addDroplet: '添加液滴',
      remove: '移除末尾',
      reset: '重置场景',
      statPrimitives: '活跃图元',
      statBridges: '已融合液桥',
      statClosestPair: '最近图元对',
      statSurfaceGap: '表面间隙',
      nonePair: '无',
    },
    segmentedDock: {
      backdropTitle: '连续流动多态导航栏',
      backdropCaption:
        '前导与滞后弹簧在切换瞬间拉开双球囊液桥，并在静止时精准收敛为单个圆角胶囊。',
      dockAriaLabel: '连续形变导航栏',
      segments: {
        overview: '概览',
        optics: '光学',
        field: 'SDF 场',
        motion: '弹簧',
        export: '规范',
      },
      panelTitle: '分段流动物理参数',
      panelDescription: '仅在移动过程中分裂为双图元融合桥，稳态及减弱动态下零开销收口。',
      horizontal: '横向排列',
      vertical: '纵向排列',
      blendKLabel: '液桥融合度（blendK）',
      maxStretchLabel: '最大分离夹紧',
      squeezeLabel: '垂直挤压系数',
      retargetButton: '飞行变轨测试',
      statActiveTab: '当前分段',
      statLobes: '活跃图元数',
      statStretch: '拉伸比',
      statMotion: '运动状态',
      motionFlowing: '流动中',
      motionSettled: '已静止',
    },
    optics: {
      backdropTitle: '实时光学与渐进降级对比',
      backdropCaption:
        '调节倒角透镜宽度、RGB 色散、模糊度与分离间隙，实时观察底层文字与色块的折射畸变。',
      splitLeftBadge: '请求模式：实时折射（Route B3）',
      splitLeftTitle: 'Route B3 透镜',
      splitLeftCaption: 'Stored-PNG SDF 位移场与三通道色散着色。',
      splitRightBadge: '降级模式：磨砂轮廓',
      splitRightTitle: '磨砂降级层',
      splitRightCaption: '标准 CSS 背景模糊 + SDF 轮廓裁切 + WebGL2 边缘光。',
      panelTitle: '光学实验台参数',
      panelDescription: '对比 Chromium 实时折射与通用高斯磨砂方案，并可叠加实时 SDF 等值线。',
      views: {
        refract: '实时折射',
        frosted: '磨砂降级',
        solid: '纯色降级',
        split: '分屏对比',
      },
      gapLabel: '图元间距',
      blendKLabel: '平滑融合度（blendK）',
      bevelLabel: '倒角透镜宽度',
      strengthLabel: '折射强度',
      dispersionLabel: 'RGB 色散宽度',
      blurLabel: '高斯模糊半径',
      saturationLabel: '背景饱和度',
      rimOpacityLabel: '边缘高光强度',
      rimPrefix: '高光',
      rimModes: {
        directional: '定向高光',
        soft: '柔和高光',
      },
      wireframeButton: 'SDF 轮廓线框',
      oscillateButton: '间距往返振荡',
      resetButton: '重置光学参数',
      statEffectiveTier: '实际渲染层',
      statGapOffset: '当前间隙',
      liveSuffix: '（实时）',
      tierLabels: {
        refract: '实时折射',
        frosted: '磨砂降级',
        solid: '纯色降级',
        split: '折射 + 磨砂',
        splitDowngraded: '磨砂 + 磨砂',
        refractDowngraded: '磨砂（自动降级）',
      },
    },
    popoverMenu: {
      backdropTitle: '生产级气泡弹窗与右键菜单',
      backdropCaption:
        '点击“操作 ▾”体验锚点形变展开，或在舞台空白处右键 / 点击下方按钮呼出定点菜单。',
      triggerLabel: '操作 ▾',
      menuAriaLabel: '液态玻璃弹出菜单',
      menuItems: {
        'refract-preset': 'Route B3 实时折射',
        'smin-fuse': '平滑并集液桥',
        interrupt: '飞行中途反向打断',
        'edge-flip': '视口边界翻转夹紧',
      },
      contextHint: '在舞台右键单击或定点呼出：',
      contextHereButton: '在此打开右键菜单',
      panelTitle: '弹窗与菜单选项',
      panelDescription: '测试不同锚点方位、外部触发牵引、裸触发源及中途打断连续性。',
      placements: {
        overAnchorEnd: '右对齐覆盖',
        overAnchorStart: '左对齐覆盖',
        belowPoint: '锚点下方',
        abovePoint: '锚点上方',
      },
      externalTrigger: '外部触发分离',
      bareSource: '裸触发器源',
      interruptDemo: '往返打断演示',
      closeMenu: '关闭菜单',
      statPhase: '当前阶段',
      statSourceMode: '触发模式',
      statLastAction: '最近选择',
      statReducedMotion: '动效策略',
      phases: {
        closed: '已关闭',
        opening: '展开中',
        open: '已打开',
        closing: '收起中',
      },
      sourceModes: {
        anchored: '锚点触发',
        point: '定点右键',
      },
      reducedMotionMode: '交叉淡入淡出',
      springMode: '物理弹簧',
      noneAction: '暂无',
    },
  },
}

export function getMessages(locale: Locale): PlaygroundMessages {
  return MESSAGES[locale]
}
