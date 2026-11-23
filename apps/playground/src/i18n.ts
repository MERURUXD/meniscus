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
  shell: {
    tagline: string
    labsNavAria: string
    statusRefract: string
    statusFrosted: string
    statusRimWebgl2: string
    statusRimCanvas2d: string
    themeLight: string
    themeDark: string
    themeGroupAria: string
    localeGroupAria: string
    backdropGroupAria: string
    backdropWallpaper: string
    backdropChart: string
    reduceMotion: string
  }
  tabs: Record<LabId, { title: string; description: string }>
  chart: {
    specimen: string
    spectrumCaption: string
    clockLabel: string
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
    splitLeftTitle: string
    splitLeftCaption: string
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
    tintLabel: string
    rimOpacityLabel: string
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
    documentTitle: 'Meniscus playground',
    shell: {
      tagline: 'Liquid glass over live, clickable DOM',
      labsNavAria: 'Labs',
      statusRefract: 'Refracting the live page with an SVG backdrop filter.',
      statusFrosted:
        'This browser can’t refract live DOM, so the glass falls back to frosted blur with the same outline.',
      statusRimWebgl2: 'Rim light drawn with WebGL2.',
      statusRimCanvas2d: 'Rim light drawn with Canvas 2D.',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeGroupAria: 'Theme',
      localeGroupAria: 'Language',
      backdropGroupAria: 'Background',
      backdropWallpaper: 'Wallpaper',
      backdropChart: 'Test chart',
      reduceMotion: 'Reduce motion',
    },
    tabs: {
      'drag-merge': {
        title: 'Drag and merge',
        description: 'Pull droplets together until they fuse.',
      },
      'segmented-dock': {
        title: 'Morphing dock',
        description: 'A selection pill that flows between tabs.',
      },
      optics: {
        title: 'Optics bench',
        description: 'Tune the lens, compare it with the fallback.',
      },
      'popover-menu': {
        title: 'Popover and menu',
        description: 'A button that melts into a menu and back.',
      },
    },
    chart: {
      specimen: 'The meniscus is the curve a liquid makes where it meets glass.',
      spectrumCaption: 'Visible spectrum, nm',
      clockLabel: 'This chart has been live for',
    },
    dragMerge: {
      backdropTitle: 'Drag and merge',
      backdropCaption:
        'Drag a droplet toward another. Inside the capture radius they fuse into one surface; pull them apart and the bridge thins until it snaps.',
      nodes: {
        anchor: { label: 'Anchor', sublabel: 'Pinned' },
        'orb-a': { label: 'Orb', sublabel: 'Drag me' },
        'orb-b': { label: 'Lens', sublabel: 'Drag me' },
        'pill-c': { label: 'Capsule', sublabel: 'Drag me' },
      },
      extraNodeLabelPrefix: 'Droplet',
      extraNodeSublabel: 'Drag me',
      panelTitle: 'Field',
      panelDescription: 'How eagerly nearby shapes melt into each other.',
      blendKLabel: 'Blend radius',
      magneticRadiusLabel: 'Capture radius',
      returnOnRelease: 'Return on release',
      snapNearest: 'Snap to nearest',
      addDroplet: 'Add droplet',
      remove: 'Remove droplet',
      reset: 'Reset',
      statPrimitives: 'Shapes',
      statBridges: 'Bridges',
      statClosestPair: 'Closest pair',
      statSurfaceGap: 'Gap between them',
      nonePair: 'None',
    },
    segmentedDock: {
      backdropTitle: 'Morphing dock',
      backdropCaption:
        'Pick a tab. The pill stretches toward it, squeezes and settles. Pick another before it lands and it turns around without a jump.',
      dockAriaLabel: 'Sections',
      segments: {
        overview: 'Overview',
        optics: 'Optics',
        field: 'Field',
        motion: 'Springs',
        export: 'Spec',
      },
      panelTitle: 'Pill',
      panelDescription: 'The shape of the pill while it travels.',
      horizontal: 'Horizontal',
      vertical: 'Vertical',
      blendKLabel: 'Blend radius',
      maxStretchLabel: 'Stretch',
      squeezeLabel: 'Squeeze',
      retargetButton: 'Change target mid-flight',
      statActiveTab: 'Selected',
      statLobes: 'Lobes',
      statStretch: 'Stretch',
      statMotion: 'Motion',
      motionFlowing: 'Moving',
      motionSettled: 'Settled',
    },
    optics: {
      backdropTitle: 'Optics bench',
      backdropCaption:
        'Two lenses over the moving background. Edges bend inside the rim; widen the bezel or raise refraction to see more of it.',
      splitLeftTitle: 'Refraction',
      splitLeftCaption: 'What Chromium renders: the live page displaced through the rim.',
      splitRightTitle: 'Frosted fallback',
      splitRightCaption: 'What Safari and Firefox get: the same outline and rim, without the bending.',
      panelTitle: 'Lens',
      panelDescription: 'Each change reaches the glass on the next frame.',
      views: {
        refract: 'Refract',
        frosted: 'Frosted',
        solid: 'Solid',
        split: 'Side by side',
      },
      gapLabel: 'Gap',
      blendKLabel: 'Blend radius',
      bevelLabel: 'Bezel width',
      strengthLabel: 'Refraction',
      dispersionLabel: 'Dispersion',
      blurLabel: 'Blur',
      saturationLabel: 'Saturation',
      tintLabel: 'Tint',
      rimOpacityLabel: 'Rim light',
      rimModes: {
        directional: 'Directional rim',
        soft: 'Soft rim',
      },
      wireframeButton: 'Show outline',
      oscillateButton: 'Breathe the gap',
      resetButton: 'Reset',
      statEffectiveTier: 'Rendering',
      statGapOffset: 'Gap',
      liveSuffix: 'moving',
      tierLabels: {
        refract: 'Refraction',
        frosted: 'Frosted',
        solid: 'Solid',
        split: 'Refraction and frosted',
        splitDowngraded: 'Frosted on both sides',
        refractDowngraded: 'Frosted, refraction unavailable',
      },
    },
    popoverMenu: {
      backdropTitle: 'Popover and menu',
      backdropCaption:
        'Open the menu and the button melts into it. Close it halfway and it reverses from where it is. Right-click the chart for a menu at the pointer.',
      triggerLabel: 'Options',
      menuAriaLabel: 'Options',
      menuItems: {
        'refract-preset': 'Duplicate',
        'smin-fuse': 'Rename',
        interrupt: 'Move to',
        'edge-flip': 'Delete',
      },
      contextHereButton: 'Open at a point',
      panelTitle: 'Menu',
      panelDescription: 'Where the menu opens from and how it gets there.',
      placements: {
        overAnchorEnd: 'From the right',
        overAnchorStart: 'From the left',
        belowPoint: 'Below',
        abovePoint: 'Above',
      },
      externalTrigger: 'Keep button visible',
      bareSource: 'Button without glass',
      interruptDemo: 'Open, close, reopen',
      closeMenu: 'Close menu',
      statPhase: 'State',
      statSourceMode: 'Opened from',
      statLastAction: 'Last choice',
      statReducedMotion: 'Motion',
      phases: {
        closed: 'Closed',
        opening: 'Opening',
        open: 'Open',
        closing: 'Closing',
      },
      sourceModes: {
        anchored: 'Button',
        point: 'Pointer',
      },
      reducedMotionMode: 'Fade only',
      springMode: 'Spring',
      noneAction: 'None',
    },
  },
  zh: {
    documentTitle: 'Meniscus 演示场',
    shell: {
      tagline: '覆在可点击实时 DOM 上的液态玻璃',
      labsNavAria: '实验',
      statusRefract: '正在用 SVG backdrop-filter 折射实时页面。',
      statusFrosted: '当前浏览器无法折射实时 DOM，玻璃退回磨砂模糊，轮廓不变。',
      statusRimWebgl2: '边缘光由 WebGL2 绘制。',
      statusRimCanvas2d: '边缘光由 Canvas 2D 绘制。',
      themeLight: '浅色',
      themeDark: '深色',
      themeGroupAria: '主题',
      localeGroupAria: '语言',
      backdropGroupAria: '背景',
      backdropWallpaper: '壁纸',
      backdropChart: '测试图样',
      reduceMotion: '减弱动态',
    },
    tabs: {
      'drag-merge': {
        title: '拖拽融合',
        description: '把液滴拖到一起，看它们融成一体。',
      },
      'segmented-dock': {
        title: '流动导航',
        description: '选中态在标签之间流动。',
      },
      optics: {
        title: '光学台',
        description: '调节镜片，与降级效果对照。',
      },
      'popover-menu': {
        title: '弹出菜单',
        description: '按钮融化成菜单，再收回去。',
      },
    },
    chart: {
      specimen: '弯月面，是液体与玻璃相接处弯出的那道弧线。',
      spectrumCaption: '可见光谱，单位 nm',
      clockLabel: '图样已实时运行',
    },
    dragMerge: {
      backdropTitle: '拖拽融合',
      backdropCaption:
        '把一颗液滴拖向另一颗。进入捕获半径后两者融成一片；再拉开，中间的液桥会逐渐变细直到断开。',
      nodes: {
        anchor: { label: '锚点', sublabel: '已固定' },
        'orb-a': { label: '圆珠', sublabel: '拖动我' },
        'orb-b': { label: '镜片', sublabel: '拖动我' },
        'pill-c': { label: '胶囊', sublabel: '拖动我' },
      },
      extraNodeLabelPrefix: '液滴',
      extraNodeSublabel: '拖动我',
      panelTitle: '场',
      panelDescription: '相邻形状互相融合的倾向有多强。',
      blendKLabel: '融合半径',
      magneticRadiusLabel: '捕获半径',
      returnOnRelease: '松手归位',
      snapNearest: '吸附最近',
      addDroplet: '添加液滴',
      remove: '移除液滴',
      reset: '重置',
      statPrimitives: '形状',
      statBridges: '液桥',
      statClosestPair: '最近的一对',
      statSurfaceGap: '两者间距',
      nonePair: '无',
    },
    segmentedDock: {
      backdropTitle: '流动导航',
      backdropCaption:
        '选一个标签。选中块会先朝它拉长、挤压，再落定。落定前改选别的标签，它会直接掉头，不会跳变。',
      dockAriaLabel: '分区',
      segments: {
        overview: '概览',
        optics: '光学',
        field: '场',
        motion: '弹簧',
        export: '规格',
      },
      panelTitle: '选中块',
      panelDescription: '选中块移动过程中的形态。',
      horizontal: '横向',
      vertical: '纵向',
      blendKLabel: '融合半径',
      maxStretchLabel: '拉伸',
      squeezeLabel: '挤压',
      retargetButton: '中途改换目标',
      statActiveTab: '已选',
      statLobes: '分叶',
      statStretch: '拉伸',
      statMotion: '运动',
      motionFlowing: '移动中',
      motionSettled: '已落定',
    },
    optics: {
      backdropTitle: '光学台',
      backdropCaption: '两块镜片压在流动的背景上。边缘内的线条和色块会弯折；加宽镜缘或调高折射能看得更清楚。',
      splitLeftTitle: '折射',
      splitLeftCaption: 'Chromium 的效果：实时页面在镜缘处发生位移。',
      splitRightTitle: '磨砂降级',
      splitRightCaption: 'Safari 与 Firefox 的效果：轮廓和边缘光相同，但不弯折。',
      panelTitle: '镜片',
      panelDescription: '每次调整都会在下一帧反映到玻璃上。',
      views: {
        refract: '折射',
        frosted: '磨砂',
        solid: '实色',
        split: '并排对照',
      },
      gapLabel: '间距',
      blendKLabel: '融合半径',
      bevelLabel: '镜缘宽度',
      strengthLabel: '折射强度',
      dispersionLabel: '色散',
      blurLabel: '模糊',
      saturationLabel: '饱和度',
      tintLabel: '着色',
      rimOpacityLabel: '边缘光',
      rimModes: {
        directional: '定向边缘光',
        soft: '柔和边缘光',
      },
      wireframeButton: '显示轮廓',
      oscillateButton: '间距呼吸',
      resetButton: '重置',
      statEffectiveTier: '渲染方式',
      statGapOffset: '间距',
      liveSuffix: '变化中',
      tierLabels: {
        refract: '折射',
        frosted: '磨砂',
        solid: '实色',
        split: '折射与磨砂',
        splitDowngraded: '两侧均为磨砂',
        refractDowngraded: '磨砂，不支持折射',
      },
    },
    popoverMenu: {
      backdropTitle: '弹出菜单',
      backdropCaption:
        '打开菜单时，按钮会融化成菜单。展开一半时关闭，它会从当前位置原路收回。在图样上右键，可在指针处打开菜单。',
      triggerLabel: '选项',
      menuAriaLabel: '选项',
      menuItems: {
        'refract-preset': '创建副本',
        'smin-fuse': '重命名',
        interrupt: '移动到',
        'edge-flip': '删除',
      },
      contextHereButton: '在某处打开',
      panelTitle: '菜单',
      panelDescription: '菜单从哪里展开，又如何到达。',
      placements: {
        overAnchorEnd: '从右侧',
        overAnchorStart: '从左侧',
        belowPoint: '向下',
        abovePoint: '向上',
      },
      externalTrigger: '保留按钮',
      bareSource: '按钮不带玻璃',
      interruptDemo: '打开、关闭、再打开',
      closeMenu: '关闭菜单',
      statPhase: '状态',
      statSourceMode: '打开方式',
      statLastAction: '上次选择',
      statReducedMotion: '动效',
      phases: {
        closed: '已关闭',
        opening: '展开中',
        open: '已打开',
        closing: '收起中',
      },
      sourceModes: {
        anchored: '按钮',
        point: '指针',
      },
      reducedMotionMode: '仅淡入淡出',
      springMode: '弹簧',
      noneAction: '无',
    },
  },
}

export function getMessages(locale: Locale): PlaygroundMessages {
  return MESSAGES[locale]
}
