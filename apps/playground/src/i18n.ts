import type { RefractionProfileName, RimMode } from '@sessile/core'
import type { PopoverPlacement } from '@sessile/presets'
import type { BackdropKind } from './components/backdropSettings.ts'
import type { LabId, OpticsPresetId, OpticsViewMode } from './labDefaults.ts'

export type Locale = 'en' | 'zh'

export const LOCALE_STORAGE_KEY = 'sessile-playground-locale'

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
    statusCompactRefract: string
    statusCompactFrosted: string
    statusCompactWebgl2: string
    statusCompactCanvas2d: string
    themeLight: string
    themeDark: string
    themeGroupAria: string
    localeGroupAria: string
    backdropLabel: string
    backdrops: Record<BackdropKind, string>
    reduceMotion: string
    motionAria: string
    motionFull: string
    motionReduced: string
    inspectorToggle: string
    inspectorShow: string
    inspectorHide: string
    tuneButton: string
    sheetTabsAria: string
    sheetMaterial: string
    sheetScene: string
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
    stageHint: string
    nodes: Record<'anchor' | 'orb-a' | 'orb-b' | 'pill-c', { label: string; sublabel: string }>
    extraNodeLabelPrefix: string
    extraNodeSublabel: string
    panelTitle: string
    panelDescription: string
    sectionField: string
    sectionBehavior: string
    sectionDroplets: string
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
    stageHint: string
    dockAriaLabel: string
    segments: Record<'overview' | 'optics' | 'field' | 'motion' | 'export', string>
    panelTitle: string
    panelDescription: string
    sectionOrientation: string
    sectionMotion: string
    sectionActions: string
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
    stageHint: string
    splitLeftTitle: string
    splitLeftCaption: string
    splitRightTitle: string
    splitRightCaption: string
    panelTitle: string
    panelDescription: string
    sectionView: string
    sectionPreset: string
    sectionGeometry: string
    sectionOptics: string
    sectionSurface: string
    sectionStage: string
    views: Record<OpticsViewMode, string>
    presets: Record<OpticsPresetId, string>
    banks: Record<'geometry' | 'optics' | 'surface', string>
    dragLensHint: string
    gapLabel: string
    blendKLabel: string
    bevelLabel: string
    profileLabel: string
    profiles: Record<RefractionProfileName, string>
    iorLabel: string
    causticsButton: string
    strengthLabel: string
    dispersionLabel: string
    blurLabel: string
    saturationLabel: string
    tintLabel: string
    rimOpacityLabel: string
    rimModeLabel: string
    lightAngleLabel: string
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
    stageHint: string
    triggerLabel: string
    menuAriaLabel: string
    menuItems: Record<'refract-preset' | 'smin-fuse' | 'interrupt' | 'edge-flip', string>
    contextHereButton: string
    panelTitle: string
    panelDescription: string
    sectionPlacement: string
    sectionSource: string
    sectionActions: string
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
  coverWall: {
    wallAriaLabel: string
    barTitle: string
    barCaption: string
    dropLabel: string
    panelTitle: string
    panelDescription: string
    sectionTier: string
    sectionRender: string
    sectionForeground: string
    tiers: Record<'off' | 'clear' | 'regular' | 'legible', string>
    renderModes: Record<'refract' | 'frosted', string>
    foregrounds: Record<'auto' | 'light' | 'dark', string>
    statTarget: string
    statFilm: string
    statBlur: string
    statRefraction: string
    statSaturation: string
    statLimit: string
    readoutOff: string
    infeasible: string
  }
}

export const MESSAGES: Record<Locale, PlaygroundMessages> = {
  en: {
    documentTitle: 'Sessile Optical Lab',
    shell: {
      tagline: 'Liquid glass over live, clickable DOM',
      labsNavAria: 'Labs',
      statusRefract: 'Refracting the live page with an SVG backdrop filter.',
      statusFrosted:
        'This browser cannot refract live DOM, so the glass falls back to frosted blur with the same outline.',
      statusRimWebgl2: 'Rim light drawn with WebGL2.',
      statusRimCanvas2d: 'Rim light drawn with Canvas 2D.',
      statusCompactRefract: 'SVG refraction',
      statusCompactFrosted: 'Frosted fallback',
      statusCompactWebgl2: 'WebGL2 rim',
      statusCompactCanvas2d: 'Canvas 2D rim',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeGroupAria: 'Theme',
      localeGroupAria: 'Language',
      backdropLabel: 'Substrate',
      backdrops: {
        prism: 'Prism',
        folds: 'Folds',
        lava: 'Lava',
        contours: 'Contours',
        aurora: 'Aurora',
        bokeh: 'Bokeh',
        mesh: 'Gradient',
        chart: 'Optical plate',
      },
      reduceMotion: 'Reduce motion',
      motionAria: 'Motion',
      motionFull: 'Spring',
      motionReduced: 'Reduced',
      inspectorToggle: 'Inspector',
      inspectorShow: 'Show tuning sheet',
      inspectorHide: 'Hide tuning sheet',
      tuneButton: 'Tune',
      sheetTabsAria: 'Inspector mode',
      sheetMaterial: 'Material',
      sheetScene: 'Scene',
    },
    tabs: {
      'drag-merge': {
        title: 'Merging drops',
        description: 'Pull droplets together until they fuse.',
      },
      'segmented-dock': {
        title: 'Segmented',
        description: 'The highlight stretches and slides between options.',
      },
      'cover-wall': {
        title: 'Cover wall',
        description: 'Scroll loud comic covers under glass that keeps its text readable.',
      },
      'popover-menu': {
        title: 'Popover',
        description: 'A button that melts into a menu and back.',
      },
    },
    chart: {
      specimen:
        'A sessile drop is a bead of liquid resting on a surface, curved by its own surface tension.',
      spectrumCaption: 'Visible spectrum, nm',
      clockLabel: 'Live elapsed',
    },
    dragMerge: {
      backdropTitle: 'Merging drops',
      backdropCaption:
        'Drag a droplet toward another. Inside the capture radius they fuse into one surface; pull them apart and the bridge thins until it snaps.',
      stageHint: 'Drag droplets together to fuse; pull apart to snap.',
      nodes: {
        anchor: { label: 'Anchor', sublabel: 'Pinned' },
        'orb-a': { label: 'Orb', sublabel: 'Drag' },
        'orb-b': { label: 'Lens', sublabel: 'Drag' },
        'pill-c': { label: 'Capsule', sublabel: 'Drag' },
      },
      extraNodeLabelPrefix: 'Droplet',
      extraNodeSublabel: 'Drag',
      panelTitle: 'Field & droplets',
      panelDescription: 'Control surface tension and how eagerly nearby shapes fuse into one contour.',
      sectionField: 'SDF field',
      sectionBehavior: 'Release behavior',
      sectionDroplets: 'Primitives',
      blendKLabel: 'Blend radius',
      magneticRadiusLabel: 'Capture radius',
      returnOnRelease: 'Return on release',
      snapNearest: 'Snap to nearest',
      addDroplet: 'Add droplet',
      remove: 'Remove',
      reset: 'Reset',
      statPrimitives: 'Shapes',
      statBridges: 'Bridges',
      statClosestPair: 'Closest pair',
      statSurfaceGap: 'Surface gap',
      nonePair: 'None',
    },
    segmentedDock: {
      backdropTitle: 'Segmented control',
      backdropCaption:
        'Pick a tab. The pill stretches toward it, squeezes and settles. Pick another before it lands and it turns around without a jump.',
      stageHint: 'Select a segment; switch mid-flight to reverse.',
      dockAriaLabel: 'Sections',
      segments: {
        overview: 'Overview',
        optics: 'Optics',
        field: 'Field',
        motion: 'Springs',
        export: 'Spec',
      },
      panelTitle: 'Morphing pill',
      panelDescription: 'Tune elastic stretch, squeeze, and blend radius while the lens travels.',
      sectionOrientation: 'Axis',
      sectionMotion: 'Elasticity',
      sectionActions: 'Stress test',
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
      backdropTitle: 'Glass material',
      backdropCaption:
        'Two lenses over the moving background. Edges bend inside the rim; widen the bezel or raise refraction to see more of it.',
      stageHint: 'Tune bezel, IOR, and dispersion in real time.',
      splitLeftTitle: 'SVG refraction',
      splitLeftCaption: 'Chromium live backdrop displacement',
      splitRightTitle: 'Frosted fallback',
      splitRightCaption: 'Safari & Firefox outline parity',
      panelTitle: 'Glass material',
      panelDescription: 'Changes apply live across every scene and Compare view.',
      sectionView: 'Render tier',
      sectionPreset: 'Material preset',
      sectionGeometry: 'Bevel & profile',
      sectionOptics: 'Refraction & dispersion',
      sectionSurface: 'Surface & rim',
      sectionStage: 'Diagnostics',
      views: {
        refract: 'Refract',
        frosted: 'Frosted',
        solid: 'Opaque',
        split: 'Compare',
      },
      presets: {
        crown: 'Crown',
        prism: 'Prism',
        meniscus: 'Meniscus',
        frost: 'Frost',
      },
      banks: {
        geometry: 'Geometry',
        optics: 'Optics',
        surface: 'Surface',
      },
      dragLensHint: 'Drag lens',
      gapLabel: 'Gap',
      blendKLabel: 'Blend radius',
      bevelLabel: 'Bezel width',
      profileLabel: 'Lens profile',
      profiles: {
        squircle: 'Squircle',
        circle: 'Circle',
        parabolic: 'Parabolic',
        lip: 'Lip',
      },
      iorLabel: 'Refractive index (IOR)',
      causticsButton: 'Caustic folds',
      strengthLabel: 'Refraction',
      dispersionLabel: 'Dispersion',
      blurLabel: 'Blur',
      saturationLabel: 'Saturation',
      tintLabel: 'Tint',
      rimOpacityLabel: 'Rim light',
      rimModeLabel: 'Rim shading',
      lightAngleLabel: 'Light angle',
      rimModes: {
        directional: 'Directional',
        soft: 'Soft',
        physical: 'Physical 3D',
      },
      wireframeButton: 'Show SDF outline',
      oscillateButton: 'Breathe gap',
      resetButton: 'Reset optics',
      statEffectiveTier: 'Rendering',
      statGapOffset: 'Gap',
      liveSuffix: 'moving',
      tierLabels: {
        refract: 'Refraction',
        frosted: 'Frosted',
        solid: 'Opaque',
        split: 'Refraction & frosted',
        splitDowngraded: 'Frosted on both sides',
        refractDowngraded: 'Frosted, refraction unavailable',
      },
    },
    coverWall: {
      wallAriaLabel: 'Procedural comic covers',
      barTitle: 'New this week',
      barCaption: 'Fixed text color. The glass yields.',
      dropLabel: 'Drag',
      panelTitle: 'Legibility stress test',
      panelDescription:
        'Scroll the wall under the bar and drag the droplet across covers. Compare how much the glass gives up at each tier.',
      sectionTier: 'Legibility tier',
      sectionRender: 'Render path',
      sectionForeground: 'Text color',
      tiers: { off: 'Off', clear: 'Clear', regular: 'Regular', legible: 'Legible' },
      renderModes: { refract: 'Refract', frosted: 'Frosted' },
      foregrounds: { auto: 'Theme', light: 'Light text', dark: 'Dark text' },
      statTarget: 'WCAG target',
      statFilm: 'Film alpha',
      statBlur: 'Blur boost',
      statRefraction: 'Refraction',
      statSaturation: 'Saturation',
      statLimit: 'Backdrop limit',
      readoutOff: 'Off',
      infeasible: 'veil alone fails',
    },
    popoverMenu: {
      backdropTitle: 'Popover menu',
      backdropCaption:
        'Open the menu and the button melts into it. Close it halfway and it reverses from where it is. Right-click the chart for a menu at the pointer.',
      stageHint: 'Click trigger to morph, or right-click stage.',
      triggerLabel: 'Options',
      menuAriaLabel: 'Options',
      menuItems: {
        'refract-preset': 'Duplicate',
        'smin-fuse': 'Rename',
        interrupt: 'Move to',
        'edge-flip': 'Delete',
      },
      contextHereButton: 'Open at point',
      panelTitle: 'Popover morph',
      panelDescription: 'Configure anchor direction, source visibility, and mid-flight interruption.',
      sectionPlacement: 'Placement',
      sectionSource: 'Trigger mode',
      sectionActions: 'Sequence',
      placements: {
        overAnchorEnd: 'From right',
        overAnchorStart: 'From left',
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
    documentTitle: 'Sessile 光学材质实验室',
    shell: {
      tagline: '覆在可点击实时 DOM 上的液态玻璃',
      labsNavAria: '实验场景',
      statusRefract: '正在用 SVG backdrop-filter 折射实时页面。',
      statusFrosted: '当前浏览器无法折射实时 DOM，玻璃退回磨砂模糊，轮廓不变。',
      statusRimWebgl2: '边缘光由 WebGL2 绘制。',
      statusRimCanvas2d: '边缘光由 Canvas 2D 绘制。',
      statusCompactRefract: 'SVG 折射',
      statusCompactFrosted: '磨砂降级',
      statusCompactWebgl2: 'WebGL2 边缘光',
      statusCompactCanvas2d: 'Canvas 2D 边缘光',
      themeLight: '浅色',
      themeDark: '深色',
      themeGroupAria: '主题',
      localeGroupAria: '语言',
      backdropLabel: '基底场景',
      backdrops: {
        prism: '棱光',
        folds: '褶皱',
        lava: '熔岩',
        contours: '等高线',
        aurora: '极光',
        bokeh: '光斑',
        mesh: '渐变',
        chart: '光学标板',
      },
      reduceMotion: '减弱动态',
      motionAria: '动效',
      motionFull: '弹簧',
      motionReduced: '减弱',
      inspectorToggle: '调参',
      inspectorShow: '展开调参面板',
      inspectorHide: '收起调参面板',
      tuneButton: '调参',
      sheetTabsAria: '调参模式',
      sheetMaterial: '玻璃材质',
      sheetScene: '场景交互',
    },
    tabs: {
      'drag-merge': {
        title: '液滴融合',
        description: '把液滴拖到一起，看它们融成一体。',
      },
      'segmented-dock': {
        title: '分段切换',
        description: '选中块在选项之间拉伸、滑动。',
      },
      'cover-wall': {
        title: '封面墙',
        description: '在高饱和漫画封面上滚动，玻璃让位保证文字可读。',
      },
      'popover-menu': {
        title: '弹出菜单',
        description: '按钮融化成菜单，再收回去。',
      },
    },
    chart: {
      specimen: '座滴，是静止在表面上、被自身表面张力托成弧形的那一滴液体。',
      spectrumCaption: '可见光谱，单位 nm',
      clockLabel: '实时运行',
    },
    dragMerge: {
      backdropTitle: '液滴融合',
      backdropCaption:
        '把一颗液滴拖向另一颗。进入捕获半径后两者融成一片；再拉开，中间的液桥会逐渐变细直到断开。',
      stageHint: '拖动液滴靠近融合，拉远即可断开。',
      nodes: {
        anchor: { label: '锚点', sublabel: '固定' },
        'orb-a': { label: '圆珠', sublabel: '拖动' },
        'orb-b': { label: '镜片', sublabel: '拖动' },
        'pill-c': { label: '胶囊', sublabel: '拖动' },
      },
      extraNodeLabelPrefix: '液滴',
      extraNodeSublabel: '拖动',
      panelTitle: '场与液滴',
      panelDescription: '调整表面张力、融合半径与松手后的弹性物理归位。',
      sectionField: 'SDF 场',
      sectionBehavior: '松手行为',
      sectionDroplets: '图元管理',
      blendKLabel: '融合半径',
      magneticRadiusLabel: '捕获半径',
      returnOnRelease: '松手归位',
      snapNearest: '吸附最近',
      addDroplet: '添加液滴',
      remove: '移除',
      reset: '重置',
      statPrimitives: '形状',
      statBridges: '液桥',
      statClosestPair: '最近的一对',
      statSurfaceGap: '表面间距',
      nonePair: '无',
    },
    segmentedDock: {
      backdropTitle: '分段切换',
      backdropCaption:
        '选一个标签。选中块会先朝它拉长、挤压，再落定。落定前改选别的标签，它会直接掉头，不会跳变。',
      stageHint: '切换标签观察拉伸，途中改选可惯性掉头。',
      dockAriaLabel: '分区',
      segments: {
        overview: '概览',
        optics: '光学',
        field: '场',
        motion: '弹簧',
        export: '规格',
      },
      panelTitle: '形变滑块',
      panelDescription: '控制玻璃胶囊在滑行时的拉伸、挤压与融合半径。',
      sectionOrientation: '方向',
      sectionMotion: '形变参数',
      sectionActions: '打断测试',
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
      backdropTitle: '玻璃材质',
      backdropCaption:
        '两块镜片压在流动的背景上。边缘内的线条和色块会弯折；加宽镜缘或调高折射能看得更清楚。',
      stageHint: '实时调节镜缘、折射率与色散效果。',
      splitLeftTitle: 'SVG 折射',
      splitLeftCaption: 'Chromium 实时背景位移',
      splitRightTitle: '磨砂降级',
      splitRightCaption: 'Safari 与 Firefox 同轮廓降级',
      panelTitle: '全局玻璃材质',
      panelDescription: '参数改动实时作用于当前实验场景与对比视图。',
      sectionView: '渲染层级',
      sectionPreset: '材质预设',
      sectionGeometry: '镜缘几何',
      sectionOptics: '折射与色散',
      sectionSurface: '表面与边缘光',
      sectionStage: '诊断控制',
      views: {
        refract: '折射',
        frosted: '磨砂',
        solid: '不透明',
        split: '对比',
      },
      presets: {
        crown: '冕牌',
        prism: '棱镜',
        meniscus: '液弯',
        frost: '柔雾',
      },
      banks: {
        geometry: '几何',
        optics: '光学',
        surface: '表面',
      },
      dragLensHint: '拖动画布镜片',
      gapLabel: '间距',
      blendKLabel: '融合半径',
      bevelLabel: '镜缘宽度',
      profileLabel: '镜缘截面',
      profiles: {
        squircle: '超椭圆',
        circle: '圆弧',
        parabolic: '抛物面',
        lip: '唇边',
      },
      iorLabel: '折射率 (IOR)',
      causticsButton: '焦散折叠',
      strengthLabel: '折射强度',
      dispersionLabel: '色散',
      blurLabel: '模糊',
      saturationLabel: '饱和度',
      tintLabel: '着色',
      rimOpacityLabel: '边缘光',
      rimModeLabel: '边缘光模式',
      lightAngleLabel: '光源角度',
      rimModes: {
        directional: '定向',
        soft: '柔和',
        physical: '3D 物理',
      },
      wireframeButton: '显示 SDF 轮廓',
      oscillateButton: '间距呼吸',
      resetButton: '重置光学',
      statEffectiveTier: '渲染方式',
      statGapOffset: '间距',
      liveSuffix: '变化中',
      tierLabels: {
        refract: '折射',
        frosted: '磨砂',
        solid: '不透明',
        split: '折射与磨砂',
        splitDowngraded: '两侧均为磨砂',
        refractDowngraded: '磨砂，不支持折射',
      },
    },
    coverWall: {
      wallAriaLabel: '程序生成的漫画封面',
      barTitle: '本周新刊',
      barCaption: '文字颜色由宿主固定，玻璃负责让位。',
      dropLabel: '拖动',
      panelTitle: '可读性压力测试',
      panelDescription: '让封面在玻璃条下滚动，或把液滴拖过封面，对比各档位下玻璃让出了多少。',
      sectionTier: '可读性档位',
      sectionRender: '渲染路径',
      sectionForeground: '文字颜色',
      tiers: { off: '关闭', clear: '通透', regular: '标准', legible: '易读' },
      renderModes: { refract: '折射', frosted: '磨砂' },
      foregrounds: { auto: '跟随主题', light: '浅色字', dark: '深色字' },
      statTarget: 'WCAG 目标',
      statFilm: '薄膜不透明度',
      statBlur: '附加模糊',
      statRefraction: '折射倍率',
      statSaturation: '饱和度倍率',
      statLimit: '底色亮度界限',
      readoutOff: '关闭',
      infeasible: '仅底色已不达标',
    },
    popoverMenu: {
      backdropTitle: '弹出菜单',
      backdropCaption:
        '打开菜单时，按钮会融化成菜单。展开一半时关闭，它会从当前位置原路收回。在图样上右键，可在指针处打开菜单。',
      stageHint: '点击按钮展开菜单，或右键画布呼出。',
      triggerLabel: '选项',
      menuAriaLabel: '选项',
      menuItems: {
        'refract-preset': '创建副本',
        'smin-fuse': '重命名',
        interrupt: '移动到',
        'edge-flip': '删除',
      },
      contextHereButton: '在某处打开',
      panelTitle: '弹出形变',
      panelDescription: '配置展开方向、触发源保留状态与展开过程中的反向打断。',
      sectionPlacement: '展开方向',
      sectionSource: '触发源状态',
      sectionActions: '状态机测试',
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
