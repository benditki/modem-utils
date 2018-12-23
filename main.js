const {app, BrowserWindow, ipcMain} = require('electron')
const modal = require('electron-modal')
const path = require('path')
const url = require('url')
const Store = require('electron-store')

const conf = new Store({ name: "settings" })

let mainWindow

function createWindow () {
  mainWindow = new BrowserWindow({width: 1600, height: 1000, title: `Modem Utils v${require('./package.json').version}`})
  mainWindow.loadURL(url.format({
    pathname: path.join(__dirname, 'batch.html'),
    protocol: 'file:',
    slashes: true
  }))

  //mainWindow.webContents.openDevTools()

  mainWindow.on('closed', function () {
    mainWindow = null
  })
  
  mainWindow.webContents.on('did-finish-load',() => {
      console.log("send", conf.path, conf.store)
      mainWindow.webContents.send('settings', conf.store)
  })
  
}

app.on('ready', () => {
    modal.setup()
    createWindow()
})

app.on('window-all-closed', function () {
  app.quit()
})

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow()
  }
})

ipcMain.on("store", (event, settings) => {
    console.log("store", conf.path, settings)
    conf.store = settings
})