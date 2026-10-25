'use strict'

const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHub } = require('./hub')
const { scanServers } = require('./servers')

// Agent Island: an always-on-top pill at the top of the screen for every Claude Code
// session on this machine. The bridge mod in each session talks to the hub started
// here; the address and token are written to ~/.claude/island/island.json.

const DIR = path.join(os.homedir(), '.claude', 'island')
const HUB_FILE = path.join(DIR, 'island.json')
const CONFIG_FILE = path.join(DIR, 'config.json')
const PORT = 47823
const SIZE = { width: 480, height: 680 }
const SKIN_NAMES = ['Classique', 'Explorateur', 'Mage', 'Bâtisseur', 'DJ', 'Monarque', 'Ninja', 'Chef', 'Pirate', 'Inventeur']

if (!app.requestSingleInstanceLock()) app.quit()

let win
let tray
let hub
let config
let state = { sessions: [], permissions: [] }
let servers = []
let hubPort = PORT
let shortcutsOn = false
const notified = new Set()

function loadConfig() {
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    // First launch.
  }
  const today = new Date().toISOString().slice(0, 10)
  const days = Array.isArray(saved.days) ? saved.days : []
  if (!days.includes(today)) days.push(today)

  return {
    skin: Number.isInteger(saved.skin) ? saved.skin : 0,
    name: typeof saved.name === 'string' && saved.name ? saved.name : 'Pixel',
    style: saved.style === 'floating' ? 'floating' : 'attached',
    theme: ['light', 'system'].includes(saved.theme) ? saved.theme : 'dark',
    notify: saved.notify !== false,
    days: days.slice(-400),
  }
}

function log(line) {
  try {
    const file = path.join(DIR, 'island.log')
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.old`)
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging never stops the island.
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

function companion() {
  const level = Math.min(10, config.days.length)

  return { skin: config.skin, name: config.name, level, days: config.days.length, skinName: SKIN_NAMES[config.skin] }
}

function theme() {
  if (config.theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'

  return config.theme
}

function publish() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('island:state', { ...state, servers, companion: companion(), style: config.style, theme: theme() })
}

function setTheme(next) {
  if (!['dark', 'light', 'system'].includes(next)) return
  config.theme = next
  saveConfig()
  publish()
  tray?.setContextMenu(buildMenu())
}

async function refreshServers() {
  try {
    const found = await scanServers({ skipPort: hubPort })
    if (JSON.stringify(found) === JSON.stringify(servers)) return
    servers = found
    publish()
  } catch (error) {
    log(`server scan: ${error.message}`)
  }
}

// Ctrl+Y / Ctrl+N answer the oldest request, and are taken only while one waits.
function updateShortcuts() {
  const pending = state.permissions.some(p => (p.type ?? 'permission') === 'permission')
  if (pending === shortcutsOn) return
  shortcutsOn = pending
  if (!pending) {
    globalShortcut.unregister('CommandOrControl+Y')
    globalShortcut.unregister('CommandOrControl+N')

    return
  }
  globalShortcut.register('CommandOrControl+Y', () => answerFirst('allow'))
  globalShortcut.register('CommandOrControl+N', () => answerFirst('deny'))
}

// Questions and plans are never answered by the allow/deny shortcuts.
function answerFirst(decision) {
  const first = state.permissions.find(p => (p.type ?? 'permission') === 'permission')
  if (first) hub.decide(first.id, decision)
}

function notifyNew() {
  for (const request of state.permissions) {
    if (notified.has(request.id)) continue
    notified.add(request.id)
    if (config.notify && Notification.isSupported()) {
      new Notification({
        title: `${request.project ?? 'Claude Code'} ${request.type === 'plan' ? 'a un plan à valider' : request.type === 'question' ? 'a une question' : 'attend ton accord'}`,
        body: request.title ?? request.tool,
        silent: false,
      }).show()
    }
  }
}

function place() {
  const { bounds } = screen.getPrimaryDisplay()
  win.setBounds({
    x: Math.round(bounds.x + (bounds.width - SIZE.width) / 2),
    y: bounds.y + (config.style === 'floating' ? 10 : 0),
    width: SIZE.width,
    height: SIZE.height,
  })
}

function createWindow() {
  win = new BrowserWindow({
    ...SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  place()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Clicks pass through the transparent window except over the island itself.
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.showInactive())
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 'warning') log(`page ${event.level}: ${event.message}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => log(`page gone: ${details.reason}`))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  screen.on('display-metrics-changed', place)
}

// A 16x16 companion, drawn pixel by pixel, doubled for the tray.
function trayIcon() {
  const art = [
    '................',
    '................',
    '................',
    '................',
    '...##########...',
    '...##########...',
    '...##K####K##...',
    '.####K####K####.',
    '.##############.',
    '...##########...',
    '...##########...',
    '...#.#....#.#...',
    '...#.#....#.#...',
    '................',
    '................',
    '................',
  ]
  const scale = 2
  const size = 16 * scale
  const buffer = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = art[Math.floor(y / scale)][Math.floor(x / scale)]
      const offset = (y * size + x) * 4
      // BGRA, as the platform's bitmaps are laid out.
      const [b, g, r, a] = cell === '#' ? [0x57, 0x77, 0xd9, 255] : cell === 'K' ? [0x12, 0x1a, 0x2a, 255] : [0, 0, 0, 0]
      buffer[offset] = b
      buffer[offset + 1] = g
      buffer[offset + 2] = r
      buffer[offset + 3] = a
    }
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size })
}

function startsAtLogin() {
  return app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] }).openAtLogin
}

function buildMenu() {
  const visible = win && win.isVisible()

  return Menu.buildFromTemplate([
    { label: 'Agent Island', enabled: false },
    { type: 'separator' },
    {
      label: 'Afficher l’île',
      type: 'checkbox',
      checked: visible,
      click: () => {
        if (win.isVisible()) win.hide()
        else win.showInactive()
        tray.setContextMenu(buildMenu())
      },
    },
    {
      label: 'Style',
      submenu: [
        { label: 'Collée au bord de l’écran', type: 'radio', checked: config.style === 'attached', click: () => setStyle('attached') },
        { label: 'Flottante', type: 'radio', checked: config.style === 'floating', click: () => setStyle('floating') },
      ],
    },
    {
      label: 'Thème',
      submenu: [
        { label: 'Sombre', type: 'radio', checked: config.theme === 'dark', click: () => setTheme('dark') },
        { label: 'Clair', type: 'radio', checked: config.theme === 'light', click: () => setTheme('light') },
        { label: 'Comme Windows', type: 'radio', checked: config.theme === 'system', click: () => setTheme('system') },
      ],
    },
    {
      label: 'Compagnon',
      submenu: SKIN_NAMES.map((name, skin) => ({
        label: name,
        type: 'radio',
        checked: config.skin === skin,
        click: () => {
          config.skin = skin
          saveConfig()
          publish()
        },
      })),
    },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: config.notify,
      click: item => {
        config.notify = item.checked
        saveConfig()
      },
    },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: startsAtLogin(),
      click: item => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [app.getAppPath()] })
      },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ])
}

function setStyle(style) {
  config.style = style
  saveConfig()
  place()
  publish()
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('Agent Island')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => {
    if (win.isVisible()) win.hide()
    else win.showInactive()
    tray.setContextMenu(buildMenu())
  })
}

ipcMain.on('island:ready', publish)
ipcMain.on('island:hover', (_event, isOver) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!isOver, { forward: true })
})
ipcMain.on('island:decide', (_event, request) => {
  if (request && typeof request.id === 'string') hub.decide(request.id, request.decision, request.answers)
})
ipcMain.on('island:companion', (_event, change) => {
  if (change && Number.isInteger(change.skin) && change.skin >= 0 && change.skin < SKIN_NAMES.length) config.skin = change.skin
  if (change && typeof change.name === 'string' && change.name.trim()) config.name = change.name.trim().slice(0, 24)
  saveConfig()
  publish()
  tray?.setContextMenu(buildMenu())
})

ipcMain.on('island:theme', (_event, next) => setTheme(next))
// Only a port the scan found opens, and only as http://localhost.
ipcMain.on('island:open-server', (_event, port) => {
  if (servers.some(s => s.port === port)) shell.openExternal(`http://localhost:${port}`)
})
nativeTheme.on('updated', () => {
  if (config?.theme === 'system') publish()
})

app.on('second-instance', () => win?.showInactive())

app.whenReady().then(async () => {
  fs.mkdirSync(DIR, { recursive: true })
  config = loadConfig()
  saveConfig()
  const token = crypto.randomBytes(24).toString('hex')
  hub = createHub({
    token,
    log,
    onChange: snapshot => {
      state = snapshot
      notifyNew()
      updateShortcuts()
      publish()
    },
  })
  const port = await hub.listen(PORT).catch(() => hub.listen(0))
  hubPort = port
  void refreshServers()
  setInterval(refreshServers, 5000)
  fs.writeFileSync(HUB_FILE, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
  log(`hub listening on 127.0.0.1:${port}`)
  createWindow()
  createTray()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  hub?.close()
  try {
    const written = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'))
    if (written.pid === process.pid) fs.unlinkSync(HUB_FILE)
  } catch {
    // Already gone.
  }
})

app.on('window-all-closed', () => {
  // The island lives in the tray; closing its window does not quit it.
})
