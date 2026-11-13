import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'
import { _electron } from 'playwright'

const root = await mkdtemp(join(tmpdir(), 'TSManager UI '))
const data = join(root, 'profile')
const results = resolve('test-results')
await mkdir(results, { recursive: true })
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const { port } = probe.address()
await new Promise((resolve) => probe.close(resolve))
await writeFile(join(root, 'fixture.cjs'), `
  require('node:http').createServer((req, res) => res.end('tsmanager-ui')).listen(Number(process.env.PORT), '127.0.0.1', () => {
    console.log('UI_TEST_READY')
  })
  process.stdin.setEncoding('utf8').on('data', data => console.log('RECEIVED:' + data.trim()))
  process.on('SIGINT', () => {})
`)
const errors = []
const executablePath = process.env.TSMANAGER_TEST_EXE
let app
let discoveredProcess

async function launch() {
  app = await _electron.launch({
    executablePath,
    args: executablePath ? [] : ['.'],
    env: { ...process.env, TSMANAGER_DATA_DIR: data },
    timeout: 25000,
  })
  const window = await app.firstWindow()
  window.setDefaultTimeout(10000)
  window.on('pageerror', (error) => errors.push(error.message))
  window.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await window.locator('.group-top .button').waitFor()
  return window
}

async function serviceRunning() {
  try {
    const response = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(400) })
    return await response.text() === 'tsmanager-ui'
  } catch { return false }
}

async function closeToTray() {
  const state = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    const destroyed = window.isDestroyed()
    return { hidden: !destroyed && !window.isVisible(), destroyed }
  })
  assert.deepEqual(state, { hidden: true, destroyed: false })
}

async function quitApp() {
  const child = app.process()
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0)
  })
  await eventually(() => child.exitCode !== null, 'Electron exits after quitting the app')
}

async function eventually(action, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await action()) return
    await wait(100)
  }
  throw new Error('Timed out: ' + label)
}

const nav = (window, label) => window.getByRole('navigation').getByRole('button', { name: label, exact: true })
const dialog = (window, name) => window.getByRole('dialog', { name, exact: true })
const backgroundColor = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor)
const workspaceColor = (page) => backgroundColor(page.locator('body'))
const lightBackground = 'rgb(255, 255, 255)'
const darkBackground = 'rgb(5, 6, 15)'
const classicBackground = 'rgb(245, 246, 250)'
const themeApplied = (page, theme) => page.locator('html[data-theme="' + theme + '"]').waitFor({ state: 'attached' })
const nativeBackground = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())

function layout(page, selectors) {
  return page.evaluate((selectors) => selectors.map((selector) => {
    const element = document.querySelector(selector)
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height, fontSize: getComputedStyle(element).fontSize }
  }), selectors)
}

function settingsDivider(page, label) {
  return nav(page, label).evaluate((element) => {
    const { left, right, height } = getComputedStyle(element, '::before')
    return { left: parseFloat(left), right: parseFloat(right), height: parseFloat(height) }
  })
}

try {
  const discoveryDir = join(root, '外部项目')
  await mkdir(discoveryDir)
  await writeFile(join(discoveryDir, 'package.json'), JSON.stringify({ name: 'discovery-fixture', scripts: { start: 'node worker.cjs' } }))
  await writeFile(join(discoveryDir, 'worker.cjs'), `
    const { createServer } = require('node:http')
    const listen = () => new Promise(resolve => {
      const server = createServer((req, res) => res.end('external-preview'))
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    process.once('message', async () => process.send(await Promise.all([listen(), listen()])))
    setInterval(() => {}, 1000)
  `)
  discoveredProcess = spawn(process.execPath, ['worker.cjs'], { cwd: discoveryDir, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let window = await launch()
  assert.equal(await nav(window, '概览').count(), 0)
  assert.equal(await nav(window, '提醒').count(), 0)
  await themeApplied(window, 'light')
  assert.equal(await workspaceColor(window), lightBackground)
  assert.equal(await nativeBackground(), '#ffffff')
  await nav(window, '设置').click()
  const themeSetting = window.getByLabel('主题')
  assert.equal(await themeSetting.inputValue(), 'light')
  assert.deepEqual(await themeSetting.locator('option').allTextContents(), ['浅色', '深色', '经典'])
  const divider = await settingsDivider(window, '设置')
  assert.ok(divider.left > 0 && divider.left === divider.right && divider.height === 1)
  const settingsSelectors = ['.navigation', '.page', '.page-header', '.settings-section', '.settings-section select']
  const lightSettings = await layout(window, settingsSelectors)
  await themeSetting.selectOption('dark')
  await themeApplied(window, 'dark')
  assert.equal(await workspaceColor(window), darkBackground)
  await eventually(async () => await nativeBackground() === '#05060f', 'preview the dark native window')
  assert.deepEqual(await layout(window, settingsSelectors), lightSettings)
  assert.deepEqual(await settingsDivider(window, '设置'), divider)
  assert.equal(await window.evaluate(async () => (await window.tsmanager.call('snapshot', null)).settings.theme), 'light')
  await themeSetting.selectOption('classic')
  await themeApplied(window, 'classic')
  assert.equal(await workspaceColor(window), classicBackground)
  await eventually(async () => await nativeBackground() === '#f5f6fa', 'preview the classic light native window')
  assert.ok((await window.locator('.navigation').boundingBox()).width > lightSettings[0].width)
  await nav(window, '项目').click()
  await themeApplied(window, 'light')
  await eventually(async () => await nativeBackground() === '#ffffff', 'restore the saved native theme')

  const detected = window.getByRole('button', { name: '加入管理 discovery-fixture' })
  await detected.waitFor()
  assert.match(await detected.locator('xpath=ancestor::section').innerText(), /默认分组/)
  const noListener = window.locator('.discovered-row').filter({ has: detected })
  await noListener.getByText('未监听', { exact: true }).waitFor()
  assert.equal(await noListener.locator('.status-dot.running').count(), 0)
  const selectExternal = window.getByRole('button', { name: 'discovery-fixture', exact: true })
  await selectExternal.press('Enter')
  await window.getByRole('heading', { name: 'discovery-fixture' }).waitFor()
  const [externalHeader, externalCard] = await layout(window, ['.detail .project-header', '.detail .detail-view'])
  assert.equal(Math.round(externalCard.y - externalHeader.y - externalHeader.height), 12)
  assert.equal(await selectExternal.getAttribute('aria-pressed'), 'true')
  await window.getByText('未监听端口', { exact: true }).waitFor()
  await window.getByText(/通过 TSManager 运行项目时会创建实时终端/).waitFor()
  assert.equal(await window.getByRole('button', { name: /网页预览/ }).count(), 0)
  await window.getByLabel('筛选状态').selectOption('running')
  await detected.waitFor({ state: 'hidden' })
  await window.getByLabel('筛选状态').selectOption('all')
  const stopExternal = window.getByRole('button', { name: '结束进程 discovery-fixture' })
  assert.equal((await stopExternal.innerText()).trim(), '结束进程')
  await stopExternal.click()
  await dialog(window, '结束进程').getByRole('button', { name: '取消' }).click()
  assert.equal(discoveredProcess.exitCode, null)
  assert.equal(discoveredProcess.signalCode, null)
  const portsReceived = once(discoveredProcess, 'message', { signal: AbortSignal.timeout(10000) })
  discoveredProcess.send('listen')
  const [externalPorts] = await portsReceived
  for (const port of externalPorts) await window.getByRole('button', { name: '网页预览 :' + port, exact: true }).waitFor()
  assert.equal(await selectExternal.getAttribute('aria-pressed'), 'true')
  const previewUrl = 'http://localhost:' + externalPorts[0]
  await app.evaluate(({ BrowserWindow, shell }, url) => {
    const openExternal = shell.openExternal
    shell.openExternal = async (address, options) => {
      if (address !== url) return openExternal(address, options)
      shell.openExternal = openExternal
      const preview = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      await preview.loadURL(address)
    }
  }, previewUrl)
  const [preview] = await Promise.all([
    app.waitForEvent('window'),
    window.getByRole('button', { name: '网页预览 :' + externalPorts[0], exact: true }).click(),
  ])
  await preview.getByText('external-preview', { exact: true }).waitFor()
  await preview.close()
  await window.locator('.header-actions').getByRole('button', { name: '加入管理', exact: true }).click()
  const discoveryForm = dialog(window, '加入管理')
  assert.equal(await discoveryForm.getByLabel('项目名称').inputValue(), 'discovery-fixture')
  assert.equal(await discoveryForm.getByLabel('启动命令').inputValue(), 'npm start')
  await discoveryForm.getByRole('button', { name: '加入管理' }).click()
  await window.getByRole('heading', { name: 'discovery-fixture' }).waitFor()
  await detected.waitFor({ state: 'hidden' })
  await window.getByLabel('发送终端命令').waitFor()
  assert.equal(await selectExternal.getAttribute('aria-pressed'), 'true')
  assert.equal(discoveredProcess.exitCode, null)
  assert.equal(discoveredProcess.signalCode, null)
  await window.locator('summary[aria-label="discovery-fixture 的更多操作"]').click()
  await window.getByRole('button', { name: '删除项目' }).click()
  await dialog(window, '删除项目').getByRole('button', { name: '删除项目' }).click()
  await detected.waitFor()
  await selectExternal.click()
  await stopExternal.click()
  await dialog(window, '结束进程').getByRole('button', { name: '结束进程' }).click()
  await eventually(() => discoveredProcess.exitCode !== null || discoveredProcess.signalCode, 'terminate confirmed external process')
  await detected.waitFor({ state: 'hidden' })
  await window.getByRole('heading', { name: '启动你的第一个项目' }).waitFor()
  await window.getByText('已结束 1 个进程。').waitFor()
  await window.screenshot({ path: join(results, 'first-run.png') })
  await window.getByRole('button', { name: '新建分组' }).click()
  await dialog(window, '新建分组').getByRole('textbox').fill('前端服务')
  await window.getByRole('button', { name: '保存分组' }).click()
  await dialog(window, '新建分组').waitFor({ state: 'hidden' })
  await window.locator('.section-heading').getByRole('button', { name: '添加项目' }).click()
  const add = dialog(window, '添加项目')
  await add.getByLabel('项目名称').fill('TS 示例服务')
  await add.locator('input[placeholder="C:\\\\Projects\\\\my-app"]').fill(root)
  await add.getByLabel('所属分组').selectOption({ label: '前端服务' })
  await add.getByLabel('Shell').selectOption('cmd')
  await add.getByLabel('启动命令').fill('node fixture.cjs')
  await add.getByRole('spinbutton').fill(String(port))
  await add.getByRole('button', { name: '配置环境变量' }).click()
  await add.getByRole('button', { name: '添加变量' }).click()
  await add.getByLabel('变量名 1').fill('API_TOKEN')
  await add.getByLabel('变量值 1').fill('test-secret')
  assert.equal(await add.getByLabel('变量值 1').getAttribute('type'), 'password')
  await add.screenshot({ path: join(results, 'project-form.png') })
  await add.getByRole('button', { name: '添加项目' }).click()
  await add.waitFor({ state: 'hidden' })
  await window.getByRole('heading', { name: 'TS 示例服务' }).waitFor()
  const group = window.getByRole('button', { name: '前端服务 1', exact: true })
  await group.click()
  assert.equal(await window.getByRole('button', { name: 'TS 示例服务', exact: true }).count(), 0)
  await group.click()
  const terminalTab = window.getByRole('button', { name: '终端', exact: true })
  const infoTab = window.getByRole('button', { name: '信息', exact: true })
  const runButton = window.getByRole('button', { name: '运行', exact: true })
  assert.equal(await backgroundColor(nav(window, '项目')), 'rgb(1, 1, 1)')
  assert.equal(await backgroundColor(terminalTab), 'rgba(0, 0, 0, 0)')
  assert.equal(await terminalTab.evaluate((node) => getComputedStyle(node, '::after').height), '2px')
  assert.equal(await backgroundColor(window.locator('.project-row.selected')), lightBackground)
  await runButton.click()
  await eventually(serviceRunning, 'start real HTTP service through UI')
  const stopButton = window.getByRole('button', { name: '停止', exact: true })
  await stopButton.waitFor()
  await window.mouse.move(0, 0)
  const stopBackground = await backgroundColor(stopButton)
  await stopButton.hover()
  assert.notEqual(await backgroundColor(stopButton), stopBackground)
  await window.mouse.move(0, 0)
  assert.equal(await backgroundColor(stopButton), stopBackground)
  await window.getByText('会话已连接').waitFor()
  await window.getByLabel('发送终端命令').fill('UI_INTERACTIVE_INPUT')
  await window.getByLabel('发送终端命令').press('Enter')
  await window.locator('.xterm-rows').getByText(/RECEIVED:UI_INTERACTIVE_INPUT/).waitFor()
  assert.deepEqual(await window.locator('.tabs button').allTextContents(), ['终端', '信息'])
  await infoTab.click()
  await window.getByRole('heading', { name: '项目信息' }).waitFor()
  assert.equal(await infoTab.evaluate((node) => getComputedStyle(node, '::after').height), '2px')
  assert.equal(await terminalTab.evaluate((node) => getComputedStyle(node, '::after').content), 'none')
  const actualPort = window.locator('dt').filter({ hasText: /^实际监听$/ }).locator('xpath=following-sibling::dd[1]')
  await eventually(async () => await actualPort.textContent() === String(port), 'show the actual listening port')
  assert.equal(await window.getByText('test-secret').count(), 0)
  await window.getByRole('button', { name: '全屏终端' }).click()
  await window.locator('.terminal-full').waitFor()
  await window.keyboard.press('Escape')
  await window.locator('.terminal-full').waitFor({ state: 'detached' })
  await window.screenshot({ path: join(results, 'running-project.png') })
  await window.keyboard.press('Control+k')
  await eventually(() => window.getByLabel('搜索项目').evaluate((node) => document.activeElement === node), 'focus project search')
  await window.getByLabel('搜索项目').fill('no-match')
  await window.getByText('没有匹配的项目').waitFor()
  await window.getByRole('button', { name: '清除搜索' }).click()
  await nav(window, '端口').click()
  await window.getByLabel('搜索端口').fill(String(port))
  await window.getByText('项目运行中', { exact: true }).waitFor()
  await nav(window, '设置').click()
  assert.equal(await workspaceColor(window), lightBackground)
  assert.deepEqual(await window.getByLabel('语言').locator('option').allTextContents(), ['简体中文', 'English'])
  await window.getByLabel('语言').selectOption('en')
  await window.getByLabel('终端字体').selectOption('Consolas')
  await window.getByRole('button', { name: '保存设置' }).click()
  await window.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  await window.getByText('Settings saved', { exact: true }).waitFor()
  assert.equal(await window.locator('html').getAttribute('lang'), 'en')
  assert.equal(await workspaceColor(window), lightBackground)
  assert.equal(await nativeBackground(), '#ffffff')
  await app.evaluate(({ BrowserWindow, shell }) => {
    const openExternal = shell.openExternal
    shell.openExternal = async (address, options) => {
      const target = new URL(address)
      if (target.hostname !== '127.0.0.1' || target.pathname !== '/preview.html') return openExternal(address, options)
      const browser = new BrowserWindow({
        show: false, width: 1350, height: 760,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
      })
      await browser.loadURL(address)
    }
  })
  const [browser] = await Promise.all([
    app.waitForEvent('window'),
    window.getByRole('button', { name: 'Open web workspace' }).click(),
  ])
  await browser.locator('.xterm-rows').getByText(/RECEIVED:UI_INTERACTIVE_INPUT/).waitFor({ timeout: 15000 })
  assert.ok(await browser.evaluate(() => location.hostname === '127.0.0.1' && location.hash === ''))
  assert.equal(await browser.locator('html').getAttribute('lang'), 'en')
  assert.equal(await browser.title(), 'TSManager · Local workspace')
  assert.equal(await workspaceColor(browser), lightBackground)
  assert.equal(await backgroundColor(nav(browser, 'Projects')), 'rgb(1, 1, 1)')
  assert.equal(await browser.locator('body').evaluate((node) => getComputedStyle(node).fontSize), '13px')
  assert.equal(await browser.locator('.name-line .status-badge').evaluate((node) => getComputedStyle(node).fontSize), '11px')
  assert.equal(await browser.getByRole('button', { name: 'Terminal', exact: true }).evaluate((node) => getComputedStyle(node, '::after').height), '2px')
  assert.equal(await browser.locator('.xterm-rows').evaluate((node) => getComputedStyle(node).color), 'rgb(25, 25, 25)')
  assert.match(await browser.locator('.xterm-rows').evaluate((node) => getComputedStyle(node).fontFamily), /^Consolas,/)
  await browser.getByLabel('Terminal command').fill('INSTALLED_WEB_INPUT')
  await browser.getByLabel('Terminal command').press('Enter')
  await browser.locator('.xterm-rows').getByText(/RECEIVED:INSTALLED_WEB_INPUT/).waitFor()
  await browser.getByRole('button', { name: 'Details', exact: true }).click()
  await browser.getByRole('heading', { name: 'Project details' }).waitFor()
  await browser.screenshot({ path: join(results, 'light-dashboard.png') })
  await browser.setViewportSize({ width: 937, height: 666 })
  assert.ok(await browser.locator('.project-workspace').evaluate((node) => node.scrollWidth <= node.clientWidth))
  assert.ok((await browser.locator('.projects').boundingBox()).width >= 350)
  const dashboardSelectors = ['.navigation', '.projects', '.splitter', '.detail', '.project-header', '.tab-strip', '.detail-view']
  const lightDashboard = await layout(browser, dashboardSelectors)
  await browser.screenshot({ path: join(results, 'light-dashboard-compact.png') })
  await nav(browser, 'Settings').click()
  await browser.getByLabel('Theme').selectOption('dark')
  await themeApplied(browser, 'dark')
  assert.equal(await workspaceColor(window), lightBackground)
  await browser.getByRole('button', { name: 'Save settings' }).click()
  await browser.getByText('Settings saved', { exact: true }).waitFor()
  await themeApplied(window, 'dark')
  await nav(browser, 'Projects').click()
  await browser.getByRole('heading', { name: 'Project details' }).waitFor()
  assert.deepEqual(await layout(browser, dashboardSelectors), lightDashboard)
  assert.equal(await workspaceColor(browser), darkBackground)
  assert.equal(await browser.getByRole('button', { name: 'Details', exact: true }).evaluate((node) => getComputedStyle(node, '::after').height), '2px')
  await browser.screenshot({ path: join(results, 'dark-dashboard-compact.png') })
  await nav(browser, 'Settings').click()
  await browser.getByLabel('Theme').selectOption('classic')
  await themeApplied(browser, 'classic')
  assert.equal(await workspaceColor(browser), classicBackground)
  await browser.getByLabel('Language').selectOption('zh-CN')
  await browser.getByLabel('Terminal font').selectOption('')
  await browser.getByLabel('Custom font name').fill('Cascadia Mono')
  await browser.getByRole('button', { name: 'Save settings' }).click()
  await browser.getByText('设置已保存', { exact: true }).waitFor()
  await themeApplied(window, 'classic')
  assert.equal(await workspaceColor(window), classicBackground)
  await window.locator('html[lang="zh-CN"]').waitFor({ state: 'attached' })
  await window.getByRole('heading', { name: '设置', exact: true }).waitFor()
  await browser.close()
  console.log('PASS: launched the bundled browser workspace and shared real PTY output and input')
  const startupSetting = window.getByLabel('启动页面')
  await startupSetting.waitFor()
  assert.deepEqual(await startupSetting.locator('option').allTextContents(), ['项目', '上次打开的页面'])
  const exitSetting = window.getByLabel('退出 TSManager 时')
  assert.equal(await exitSetting.inputValue(), 'stop')
  await closeToTray()
  assert.ok(await serviceRunning(), 'closing to the tray keeps the service running with Stop All selected')
  const second = spawn(executablePath || electron, executablePath ? [] : ['.'], {
    env: { ...process.env, TSMANAGER_DATA_DIR: data }, windowsHide: true, stdio: 'ignore',
  })
  const [secondExitCode] = await once(second, 'exit')
  assert.equal(secondExitCode, 0)
  await eventually(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()), 'restore the window from the tray on second launch')
  assert.equal(app.windows().length, 1)
  console.log('PASS: closing to the tray preserved the window and HTTP service, and relaunching restored the same window')
  await exitSetting.selectOption('keep')
  await window.getByLabel('语言').selectOption('en')
  await window.getByRole('button', { name: '保存设置' }).click()
  await window.getByText('Settings saved', { exact: true }).waitFor()
  await quitApp()
  await wait(4500)
  assert.ok(await serviceRunning(), 'keep-running after real Electron quit')
  console.log('PASS: quitting with Keep Running preserved the HTTP service')
  window = await launch()
  await window.getByText('Session connected').waitFor()
  assert.equal(await window.locator('html').getAttribute('lang'), 'en')
  await themeApplied(window, 'classic')
  assert.equal(await workspaceColor(window), classicBackground)
  assert.equal(await nativeBackground(), '#f5f6fa')
  assert.ok((await window.locator('.navigation').boundingBox()).width > lightSettings[0].width)
  assert.equal(await nav(window, 'Projects').evaluate((node) => getComputedStyle(node).color), 'rgb(10, 80, 248)')
  assert.equal(await window.locator('.tabs button.chosen').evaluate((node) => getComputedStyle(node, '::after').height), '3px')
  assert.equal(await backgroundColor(window.locator('.terminal-surface')), 'rgb(244, 246, 250)')
  assert.equal(await window.locator('.xterm-rows').evaluate((node) => getComputedStyle(node).color), 'rgb(29, 38, 54)')
  assert.match(await window.locator('.xterm-rows').evaluate((node) => getComputedStyle(node).fontFamily), /^"Cascadia Mono",/)
  await window.screenshot({ path: join(results, 'classic-dashboard.png') })
  await nav(window, 'Settings').click()
  assert.equal(await window.getByLabel('Language').inputValue(), 'en')
  assert.equal(await window.getByLabel('Theme').inputValue(), 'classic')
  assert.equal(await window.getByLabel('Custom font name').inputValue(), 'Cascadia Mono')
  await window.getByLabel('When quitting TSManager').selectOption('stop')
  await window.getByLabel('Language').selectOption('zh-CN')
  await window.getByRole('button', { name: 'Save settings' }).click()
  await window.getByText('设置已保存', { exact: true }).waitFor()
  await closeToTray()
  await quitApp()
  await eventually(async () => !await serviceRunning(), 'Stop All on Electron quit from the tray')
  window = await launch()
  await window.locator('summary[aria-label="TS 示例服务 的更多操作"]').click()
  await window.getByRole('button', { name: '编辑项目' }).click()
  await dialog(window, '编辑项目').getByLabel('项目名称').fill('已编辑项目')
  await window.getByRole('button', { name: '保存修改' }).click()
  await window.getByRole('heading', { name: '已编辑项目' }).waitFor()
  await nav(window, '运行历史').click()
  await window.getByText('TS 示例服务', { exact: true }).waitFor()
  await nav(window, '项目').click()
  await window.locator('summary[aria-label="已编辑项目 的更多操作"]').click()
  await window.getByRole('button', { name: '删除项目' }).click()
  await dialog(window, '删除项目').getByRole('button', { name: '删除项目' }).click()
  await window.getByRole('heading', { name: '启动你的第一个项目' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: Electron UI, real IPC, external Node discovery and import, create/edit/delete, terminal I/O, fullscreen, search, ports, settings, keep-running and Stop All')
} catch (error) {
  console.error(errors)
  throw error
} finally {
  if (app) {
    let window = app.windows()[0]
    if (!window && await serviceRunning()) window = await launch().catch(() => undefined)
    await window?.evaluate(async () => {
      const snapshot = await window.tsmanager.call('snapshot', null)
      await window.tsmanager.call('settings', { ...snapshot.settings, exit: 'stop' })
    }).catch(() => {})
    if (app.process().exitCode === null) await quitApp().catch(() => app.process().kill())
  }
  if (discoveredProcess && discoveredProcess.exitCode === null && !discoveredProcess.signalCode) {
    const exited = once(discoveredProcess, 'exit')
    discoveredProcess.kill()
    await exited
  }
  await wait(4500)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
}
