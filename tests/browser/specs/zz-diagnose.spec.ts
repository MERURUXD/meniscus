// TEMPORARY: bisects why the frosted veil shows no blur in Firefox/WebKit on CI.
import { test } from '@playwright/test'
import { CENTER } from './geometry.ts'
import { lumaStdDev, openFixture, stableScreenshot } from './pixels.ts'

const variants: Record<string, string> = {
  plain: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)',
  isolate: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);isolation:isolate',
  clip: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);clip-path:inset(0 round 48px)',
  clipPath: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);clip-path:path("M0 0L320 0L320 200L0 200Z")',
  transform: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transform:translate3d(0,0,0)',
  negZ: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:-1',
  tinted: 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(255,255,255,0.01)',
}

for (const [name, css] of Object.entries(variants)) {
  test(`diagnose ${name}`, async ({ page, browserName }) => {
    await openFixture(page)
    await page.evaluate((css) => {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'position:absolute;inset:0;z-index:0'
      const el = document.createElement('div')
      el.style.cssText = `position:absolute;left:240px;top:200px;width:320px;height:200px;${css}`
      wrap.appendChild(el)
      document.getElementById('stage')!.appendChild(wrap)
    }, css)
    await page.evaluate(() => window.harness.nextFrames(5))
    const shot = await stableScreenshot(page)
    const computed = await page.evaluate(() => {
      const el = document.querySelector('#stage div div') as HTMLElement
      const cs = getComputedStyle(el)
      return `${cs.getPropertyValue('backdrop-filter')} | ${cs.getPropertyValue('-webkit-backdrop-filter')} | supports=${CSS.supports('backdrop-filter', 'blur(1px)')}/${CSS.supports('-webkit-backdrop-filter', 'blur(1px)')}`
    })
    console.log(`  DIAG ${browserName} ${name}: stddev=${lumaStdDev(shot, CENTER).toFixed(1)} computed=${computed}`)
  })
}
