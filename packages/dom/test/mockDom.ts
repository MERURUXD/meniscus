/**
 * Lightweight deterministic DOM, SVG, MediaQueryList, and ResizeObserver test mocks
 * for running `@meniscus/dom` unit tests directly under Node 24 (`node --test`).
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export class MockStyleDeclaration {
  private readonly props = new Map<string, string>()

  private normalizeKey(name: string): string {
    if (name.startsWith('-')) return name.toLowerCase()
    return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
  }

  setProperty(name: string, value: string): void {
    this.props.set(this.normalizeKey(name), String(value))
  }

  getPropertyValue(name: string): string {
    return this.props.get(this.normalizeKey(name)) ?? ''
  }

  removeProperty(name: string): string {
    const k = this.normalizeKey(name)
    const prev = this.props.get(k) ?? ''
    this.props.delete(k)
    return prev
  }

  get position(): string { return this.getPropertyValue('position') }
  set position(v: string) { this.setProperty('position', v) }

  get top(): string { return this.getPropertyValue('top') }
  set top(v: string) { this.setProperty('top', v) }

  get left(): string { return this.getPropertyValue('left') }
  set left(v: string) { this.setProperty('left', v) }

  get width(): string { return this.getPropertyValue('width') }
  set width(v: string) { this.setProperty('width', v) }

  get height(): string { return this.getPropertyValue('height') }
  set height(v: string) { this.setProperty('height', v) }

  get overflow(): string { return this.getPropertyValue('overflow') }
  set overflow(v: string) { this.setProperty('overflow', v) }

  get pointerEvents(): string { return this.getPropertyValue('pointer-events') }
  set pointerEvents(v: string) { this.setProperty('pointer-events', v) }

  get visibility(): string { return this.getPropertyValue('visibility') }
  set visibility(v: string) { this.setProperty('visibility', v) }

  get opacity(): string { return this.getPropertyValue('opacity') }
  set opacity(v: string) { this.setProperty('opacity', v) }

  get zIndex(): string { return this.getPropertyValue('z-index') }
  set zIndex(v: string) { this.setProperty('z-index', v) }

  get isolation(): string { return this.getPropertyValue('isolation') }
  set isolation(v: string) { this.setProperty('isolation', v) }

  get transform(): string { return this.getPropertyValue('transform') }
  set transform(v: string) { this.setProperty('transform', v) }

  get clipPath(): string { return this.getPropertyValue('clip-path') }
  set clipPath(v: string) { this.setProperty('clip-path', v) }

  get backdropFilter(): string { return this.getPropertyValue('backdrop-filter') }
  set backdropFilter(v: string) { this.setProperty('backdrop-filter', v) }

  get background(): string { return this.getPropertyValue('background') }
  set background(v: string) { this.setProperty('background', v) }

  get backgroundColor(): string { return this.getPropertyValue('background-color') }
  set backgroundColor(v: string) { this.setProperty('background-color', v) }

  get transition(): string { return this.getPropertyValue('transition') }
  set transition(v: string) { this.setProperty('transition', v) }

  get borderTopWidth(): string { return this.getPropertyValue('border-top-width') }
  set borderTopWidth(v: string) { this.setProperty('border-top-width', v) }

  get borderTopColor(): string { return this.getPropertyValue('border-top-color') }
  set borderTopColor(v: string) { this.setProperty('border-top-color', v) }

  get boxShadow(): string { return this.getPropertyValue('box-shadow') }
  set boxShadow(v: string) { this.setProperty('box-shadow', v) }

  get borderTopLeftRadius(): string { return this.getPropertyValue('border-top-left-radius') }
  set borderTopLeftRadius(v: string) { this.setProperty('border-top-left-radius', v) }

  get colorScheme(): string { return this.getPropertyValue('color-scheme') }
  set colorScheme(v: string) { this.setProperty('color-scheme', v) }
}

export class MockElement {
  readonly tagName: string
  readonly namespaceURI: string
  readonly ownerDocument: MockDocument
  readonly style = new MockStyleDeclaration()
  readonly childNodes: MockElement[] = []
  readonly attributes = new Map<string, string>()
  readonly setAttributeCalls: Array<{ name: string; value: string }> = []
  parentNode: MockElement | null = null

  width = 0
  height = 0
  private boundingRect: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  constructor(tagName: string, ownerDocument: MockDocument, namespaceURI = 'http://www.w3.org/1999/xhtml') {
    this.tagName = tagName
    this.ownerDocument = ownerDocument
    this.namespaceURI = namespaceURI
  }

  get firstChild(): MockElement | null {
    return this.childNodes[0] ?? null
  }

  get children(): MockElement[] {
    return [...this.childNodes]
  }

  get id(): string {
    return this.attributes.get('id') ?? ''
  }

  set id(val: string) {
    this.setAttribute('id', val)
  }

  setBoundingClientRect(rect: { x: number; y: number; width: number; height: number }): void {
    this.boundingRect = { ...rect }
  }

  getBoundingClientRect(): DOMRect {
    return {
      ...this.boundingRect,
      left: this.boundingRect.x,
      top: this.boundingRect.y,
      right: this.boundingRect.x + this.boundingRect.width,
      bottom: this.boundingRect.y + this.boundingRect.height,
      toJSON: () => this.boundingRect,
    } as DOMRect
  }

  appendChild<T extends MockElement>(node: T): T {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    this.childNodes.push(node)
    node.parentNode = this
    return node
  }

  insertBefore<T extends MockElement>(node: T, referenceNode: MockElement | null): T {
    if (!referenceNode) {
      return this.appendChild(node)
    }
    const idx = this.childNodes.indexOf(referenceNode)
    if (idx === -1) {
      throw new Error('Reference node is not a child of this parent')
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    const insertIdx = this.childNodes.indexOf(referenceNode)
    this.childNodes.splice(insertIdx, 0, node)
    node.parentNode = this
    return node
  }

  removeChild<T extends MockElement>(node: T): T {
    const idx = this.childNodes.indexOf(node)
    if (idx === -1) {
      throw new Error('Node to be removed is not a child')
    }
    this.childNodes.splice(idx, 1)
    node.parentNode = null
    return node
  }

  setAttribute(name: string, value: string): void {
    const str = String(value)
    this.attributes.set(name, str)
    this.setAttributeCalls.push({ name, value: str })
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  closest(selector: string): MockElement | null {
    if (selector === '[data-theme]') {
      if (this.hasAttribute('data-theme')) return this
      let cur = this.parentNode
      while (cur) {
        if (cur.hasAttribute('data-theme')) return cur
        cur = cur.parentNode
      }
      return null
    }
    return null
  }

  querySelectorAll(tagName: string): MockElement[] {
    const target = tagName.toLowerCase()
    const matches: MockElement[] = []
    const walk = (node: MockElement) => {
      for (const child of node.childNodes) {
        if (child.tagName.toLowerCase() === target) {
          matches.push(child)
        }
        walk(child)
      }
    }
    walk(this)
    return matches
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener)
  }

  getContext(): null {
    return null
  }
}

export class MockDocument {
  readonly documentElement: MockElement
  readonly body: MockElement

  constructor() {
    this.documentElement = new MockElement('html', this)
    this.body = new MockElement('body', this)
    this.documentElement.appendChild(this.body)
  }

  createElement(tagName: string): HTMLElement {
    return new MockElement(tagName.toLowerCase(), this) as unknown as HTMLElement
  }

  createElementNS(namespaceURI: string, tagName: string): Element {
    return new MockElement(tagName, this, namespaceURI) as unknown as Element
  }
}

export interface MockMediaQueryController {
  mediaQueryList: MediaQueryList
  dispatchChange(matches: boolean): void
  listenerCount(): number
}

export function createMockMediaQueryList(
  initialMatches: boolean,
  mode: 'modern' | 'legacy' = 'modern',
): MockMediaQueryController {
  let matches = initialMatches
  const modernListeners = new Set<(event: MediaQueryListEvent) => void>()
  const legacyListeners = new Set<(event: MediaQueryListEvent) => void>()

  const mql: Partial<MediaQueryList> = {
    media: '(prefers-reduced-motion: reduce)',
    get matches() {
      return matches
    },
  }

  if (mode === 'modern') {
    mql.addEventListener = (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        modernListeners.add(listener as (event: MediaQueryListEvent) => void)
      }
    }
    mql.removeEventListener = (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        modernListeners.delete(listener as (event: MediaQueryListEvent) => void)
      }
    }
  } else {
    mql.addListener = (listener) => {
      if (listener) legacyListeners.add(listener)
    }
    mql.removeListener = (listener) => {
      if (listener) legacyListeners.delete(listener)
    }
  }

  return {
    mediaQueryList: mql as MediaQueryList,
    dispatchChange(nextMatches: boolean) {
      matches = nextMatches
      const event = { matches: nextMatches, media: mql.media } as MediaQueryListEvent
      for (const fn of [...modernListeners]) fn(event)
      for (const fn of [...legacyListeners]) fn(event)
    },
    listenerCount() {
      return modernListeners.size + legacyListeners.size
    },
  }
}

export interface MockResizeObserverRecord {
  instance: MockResizeObserver
  observed: Set<Element>
  observeOptions: Array<ResizeObserverOptions | undefined>
  disconnected: boolean
  trigger(entries: Array<Partial<ResizeObserverEntry>>): void
}

export class MockResizeObserver implements ResizeObserver {
  static records: MockResizeObserverRecord[] = []

  private readonly callback: ResizeObserverCallback
  readonly observed = new Set<Element>()
  readonly observeOptions: Array<ResizeObserverOptions | undefined> = []
  disconnected = false

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.records.push({
      instance: this,
      observed: this.observed,
      observeOptions: this.observeOptions,
      get disconnected() {
        return this.instance.disconnected
      },
      trigger: (entries) => {
        if (this.disconnected) return
        this.callback(entries as ResizeObserverEntry[], this)
      },
    })
  }

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.observed.add(target)
    this.observeOptions.push(options)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }
}
