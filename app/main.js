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
// How to start this island again: the bridge mod reads it to open the island when a
// Claude Code session starts and none is running.
const LAUNCH_FILE = path.join(DIR, 'launch.json')
const PORT = 47823
// Where the island can rest: the top, middle or bottom of the screen, on the left, in
// the centre or on the right. The page shows them while the island is held, and a drop
// lands on the nearest.
const ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]
const SKIN_NAMES = {
  en: ['Classic', 'Explorer', 'Wizard', 'Builder', 'DJ', 'Monarch', 'Ninja', 'Chef', 'Pirate', 'Inventor'],
  fr: ['Classique', 'Explorateur', 'Mage', 'Bâtisseur', 'DJ', 'Monarque', 'Ninja', 'Chef', 'Pirate', 'Inventeur'],
}
const SKIN_COUNT = 10

// The app's own words (tray menu, notifications); the page has its own in renderer/i18n.js.
const WORDS = {
  en: {
    show: 'Show the island',
    style: 'Style',
    attached: 'Attached to the screen edge',
    floating: 'Floating',
    theme: 'Theme',
    dark: 'Dark',
    light: 'Light',
    system: 'Follow Windows',
    language: 'Language',
    companion: 'Companion',
    tuck: 'Tuck into a notch when idle',
    reset: 'Back to the top centre',
    screen: 'Screen',
    screenN: 'Screen {n} ({w}×{h})',
    notifications: 'Notifications',
    startup: process.platform === 'darwin' ? 'Open at login' : 'Start with Windows',
    withClaude: 'Open with Claude Code',
    quit: 'Quit',
    'notify.plan': '{project} has a plan to review',
    'notify.question': '{project} has a question',
    'notify.permission': '{project} is waiting for you',
  },
  fr: {
    show: 'Afficher l’île',
    style: 'Style',
    attached: 'Collée au bord de l’écran',
    floating: 'Flottante',
    theme: 'Thème',
    dark: 'Sombre',
    light: 'Clair',
    system: 'Comme Windows',
    language: 'Langue',
    companion: 'Compagnon',
    tuck: 'Se replier en encoche quand elle est inactive',
    reset: 'Remettre en haut au centre',
    screen: 'Écran',
    screenN: 'Écran {n} ({w}×{h})',
    notifications: 'Notifications',
    startup: process.platform === 'darwin' ? 'Ouvrir à la connexion' : 'Lancer au démarrage de Windows',
    withClaude: 'Ouvrir avec Claude Code',
    quit: 'Quitter',
    'notify.plan': '{project} a un plan à valider',
    'notify.question': '{project} a une question',
    'notify.permission': '{project} attend ton accord',
  },
}

function w(key, vars = {}) {
  const text = (WORDS[config?.lang] ?? WORDS.en)[key] ?? WORDS.en[key]

  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
}

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
    // A BOM (Windows editors, PowerShell) would make the whole file unreadable.
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
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
    lang: saved.lang === 'fr' ? 'fr' : 'en',
    anchor: ANCHORS.includes(saved.anchor) ? saved.anchor : 'top-center',
    display: Number.isInteger(saved.display) ? saved.display : undefined,
    tuck: saved.tuck !== false,
    notify: saved.notify !== false,
    withClaude: saved.withClaude !== false,
    // Unset until chosen in the menu (or in config.json): then applied at each launch.
    startup: typeof saved.startup === 'boolean' ? saved.startup : undefined,
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

  return { skin: config.skin, name: config.name, level, days: config.days.length, skinName: SKIN_NAMES[config.lang][config.skin] }
}

function theme() {
  if (config.theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'

  return config.theme
}

function publish() {
  if (!win || win.isDestroyed()) return
  const [vertical, horizontal] = config.anchor.split('-')
  win.webContents.send('island:state', {
    ...state,
    servers,
    companion: companion(),
    style: config.style,
    theme: theme(),
    lang: config.lang,
    placement: { vertical, horizontal },
    area: area(),
    tuck: config.tuck,
  })
}

function setLang(next) {
  if (!['en', 'fr'].includes(next)) return
  config.lang = next
  saveConfig()
  publish()
  tray?.setContextMenu(buildMenu())
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
        title: w(`notify.${request.type === 'plan' || request.type === 'question' ? request.type : 'permission'}`, { project: request.project ?? 'Claude Code' }),
        body: request.title ?? request.tool,
        silent: false,
      }).show()
    }
  }
}

function anchorDisplay() {
  return screen.getAllDisplays().find(d => d.id === config.display) ?? screen.getPrimaryDisplay()
}

// The window covers the whole screen, transparent and click-through: the island moves
// inside the page (on the GPU), never the window. The page gets the work area (the
// screen minus the taskbar) in its own coordinates.
function area() {
  const { bounds, workArea } = anchorDisplay()

  return { x: workArea.x - bounds.x, y: workArea.y - bounds.y, width: workArea.width, height: workArea.height }
}

function place() {
  win.setBounds(anchorDisplay().bounds)
  publish()
}

function createWindow() {
  win = new BrowserWindow({
    ...anchorDisplay().bounds,
    enableLargerThanScreen: true,
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

// A 16x16 mascot, drawn pixel by pixel, doubled for the tray.
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

// A packaged app is its own executable; in development it is Electron plus this folder.
const launchArgs = () => (app.isPackaged ? [] : [app.getAppPath()])

function startsAtLogin() {
  return app.getLoginItemSettings({ path: process.execPath, args: launchArgs() }).openAtLogin
}

function setStartup(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: launchArgs() })
}

function writeLaunch() {
  const argv = [process.execPath, ...launchArgs()]
  const command = argv.map(a => `"${a}"`).join(' ')
  fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ platform: process.platform, argv, command, auto: config.withClaude }, null, 2))
}

function buildMenu() {
  const visible = win && win.isVisible()

  return Menu.buildFromTemplate([
    { label: 'Agent Island', enabled: false },
    { type: 'separator' },
    {
      label: w('show'),
      type: 'checkbox',
      checked: visible,
      click: () => {
        if (win.isVisible()) win.hide()
        else win.showInactive()
        tray.setContextMenu(buildMenu())
      },
    },
    {
      label: w('style'),
      submenu: [
        { label: w('attached'), type: 'radio', checked: config.style === 'attached', click: () => setStyle('attached') },
        { label: w('floating'), type: 'radio', checked: config.style === 'floating', click: () => setStyle('floating') },
      ],
    },
    {
      label: w('theme'),
      submenu: [
        { label: w('dark'), type: 'radio', checked: config.theme === 'dark', click: () => setTheme('dark') },
        { label: w('light'), type: 'radio', checked: config.theme === 'light', click: () => setTheme('light') },
        { label: w('system'), type: 'radio', checked: config.theme === 'system', click: () => setTheme('system') },
      ],
    },
    {
      label: w('language'),
      submenu: [
        { label: 'English', type: 'radio', checked: config.lang === 'en', click: () => setLang('en') },
        { label: 'Français', type: 'radio', checked: config.lang === 'fr', click: () => setLang('fr') },
      ],
    },
    {
      label: w('companion'),
      submenu: SKIN_NAMES[config.lang].map((name, skin) => ({
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
      label: w('tuck'),
      type: 'checkbox',
      checked: config.tuck,
      click: item => {
        config.tuck = item.checked
        saveConfig()
        publish()
      },
    },
    {
      label: w('reset'),
      click: () => {
        config.anchor = 'top-center'
        saveConfig()
        publish()
      },
    },
    ...(screen.getAllDisplays().length > 1
      ? [
          {
            label: w('screen'),
            submenu: screen.getAllDisplays().map((d, i) => ({
              label: w('screenN', { n: i + 1, w: d.size.width, h: d.size.height }),
              type: 'radio',
              checked: anchorDisplay().id === d.id,
              click: () => {
                config.display = d.id
                saveConfig()
                place()
              },
            })),
          },
        ]
      : []),
    {
      label: w('notifications'),
      type: 'checkbox',
      checked: config.notify,
      click: item => {
        config.notify = item.checked
        saveConfig()
      },
    },
    {
      label: w('startup'),
      type: 'checkbox',
      checked: startsAtLogin(),
      click: item => {
        config.startup = item.checked
        saveConfig()
        setStartup(item.checked)
      },
    },
    {
      label: w('withClaude'),
      type: 'checkbox',
      checked: config.withClaude,
      click: item => {
        config.withClaude = item.checked
        saveConfig()
        writeLaunch()
      },
    },
    { type: 'separator' },
    { label: w('quit'), click: () => app.quit() },
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
  if (change && Number.isInteger(change.skin) && change.skin >= 0 && change.skin < SKIN_COUNT) config.skin = change.skin
  if (change && typeof change.name === 'string' && change.name.trim()) config.name = change.name.trim().slice(0, 24)
  saveConfig()
  publish()
  tray?.setContextMenu(buildMenu())
})

ipcMain.on('island:theme', (_event, next) => setTheme(next))
ipcMain.on('island:anchor', (_event, anchor) => {
  if (!ANCHORS.includes(anchor)) return
  config.anchor = anchor
  saveConfig()
  publish()
})
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
  if (config.startup !== undefined && config.startup !== startsAtLogin()) setStartup(config.startup)
  writeLaunch()
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
