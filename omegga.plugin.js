const path = require('path');
const chokidar = require('chokidar');

const { mkdir, mv, rm, cp, ago, exists } = require('./util.js');
const {
  chat: { sanitize },
  pattern: { explode }
} = OMEGGA_UTIL;

const pkg = require('./package.json');

// filename that
const TEMP_SAVE_FILENAME = 'autosave_ez_temp.brs';
const TEMP_LOAD_FILENAME = 'autosave_ez_temp_load.brs';
const PAGE_SIZE = 5;

// regex that parses save dates out of save names
const SAVE_REGEX =
  '(?<year>\\d{4})(?<month>\\d{2})(?<day>\\d{2})(?<hour>\\d{2})(?<min>\\d{2})(?<sec>\\d{2})';
const KEEP_REGEX = '.*?(?<keep>_keep)?';

const colorKey = (color, str) =>
  `<color=\\"${color}\\">${sanitize(str + '')}</>`;
const yellow = str => colorKey('ffff99', str);
const red = str => colorKey('ff9999', str);
const green = str => colorKey('99ff99', str);

module.exports = class AutosaveEz {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
    this.ids = 0;

    this.listeningPlugins = [];

    // miliseconds between autosaves
    this.saveInterval = Math.max(config['save-interval'], 1) * 60000;

    // miliseconds between keep autosaves
    this.autokeepInterval = Math.max(config['autokeep-interval'], 0) * 60000;

    // number of saves to keep before culling non-keep'd saves
    this.numKeepSaves = Math.max(config['num-saves'], 0);

    // temporary save file
    this.tempFilePath = path.join(omegga.savePath, TEMP_SAVE_FILENAME);
    this.tempLoadFilePath = path.join(omegga.savePath, TEMP_LOAD_FILENAME);

    // destination path
    this.destFilePath = path.join(
      omegga.savePath,
      this.sanitizeFile(config['folder'] || '')
    );

    if (Omegga.verbose) console.log('Creating configured autosave directory');
    // create folders up to destination path
    mkdir(this.destFilePath);

    // create a "watcher" to check if the autosave temp file changes
    this.watcher = chokidar.watch(this.tempFilePath);

    // move the autosave temp file when it is created
    this.watcher
      .on('add', file => {
        if (Omegga.verbose) console.log('Autosave temp created @', file);
        this.moveAutoSave();
      })
      .on('unlink', () => {
        if (this.resolve) {
          this.resolve(true);
          this.resolve = undefined;
        }
      })
      .on('change', () => {
        this.moveAutoSave();
      });

    this.lastBricks = -1;
    this.lastComponents = -1;
    this.countChanged = true;

    // set default save name format
    this.saveNameFormat = config['filename-format'] || '';
    if (!this.saveNameFormat.includes('$DATE'))
      this.saveNameFormat = 'autosave_$DATE';

    // match the format
    this.saveNameRegex = new RegExp(
      '^' +
        this.saveNameFormat.replace(/\$DATE/, SAVE_REGEX) +
        KEEP_REGEX +
        '\\.brs$',
      'i'
    );
    this.parseSaveName = this.parseSaveName.bind(this);

    this.saves = [];
    try {
      this.saves = this.scanSaves();
      console.log('Found', this.saves.length, 'autosaves');
      const latestSave = this.getLatestSave();
      if (latestSave) console.log('Latest is from', latestSave.date.toString());
    } catch (err) {
      console.error('Error scanning saves', err);
    }
  }

  // sanitize a filename to limited characters
  sanitizeFile(name) {
    return name.replace(/[^\w=-]/g, '').slice(0, 20);
  }

  // message a person or everyone if it's a4
  toOne(name, ...messages) {
    Omegga.whisper(name, ...messages);
  }

  // extract data from save name
  parseSaveName(filename) {
    // get basename from absolute path
    const base = path.basename(filename);
    const match = base.match(this.saveNameRegex);
    if (!match) return undefined;

    // yes, I know I could have just stored it in ISO format, this format is just so easy to sort
    const { year, month, day, hour, min, sec } = match.groups;
    const date = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`);

    // determine if this save is a keep save
    const keep = typeof match.groups.keep !== 'undefined';

    return {
      date,
      unix: date.getTime(),
      keep,
      filename,
      name: base,
      id: ++this.ids
    };
  }

  // get a formatted save name
  genSaveName(date, keep) {
    // create a YYYYmmddHHMMSS datestamp
    const timestamp = (date || new Date())
      .toISOString()
      .replace(/[:T-]/g, '')
      .replace(/\..+/, '');

    // insert it into the format
    const filename =
      this.saveNameFormat.replace(/\$DATE/g, timestamp) + (keep ? '_keep' : '');

    return filename + '.brs';
  }

  // move a save, assume that the file exists when this is called
  moveAutoSave() {
    const date = new Date();
    const unix = date.getTime();

    // if autokeep is enabled, only keep if the most recent keep is less than the interval away
    const isAutoKeep = this.autokeepInterval > 0 && !this.saves.some(s =>
      s.keep && s.unix + this.autokeepInterval > unix);

    const filename = this.genSaveName(date, isAutoKeep);

    // find the path at which it should reside
    const filepath = path.join(this.destFilePath, filename);

    // move the save file
    mv(this.tempFilePath, filepath).then(() => this.emitAll('save', filepath));

    // add the save to the saves object
    this.saves.push({
      date,
      unix,
      keep: isAutoKeep,
      filename: filepath,
      name: path.basename(filename),
      id: ++this.ids
    });
  }

  // scan the saves directory for the autosaves
  scanSaves() {
    this.ids = 0;

    // get a list of saves in the autosave folder
    return this.omegga
      .getSaves()
      .filter(s => s.startsWith(this.destFilePath + '/')) // only get ones in the correct folder
      .map(this.parseSaveName) // parse the saves by name
      .filter(s => s) // filter by successful parses
      .sort((a, b) => a.unix - b.unix); // sort by create date
  }

  cullSaves() {
    // list of saves that need to be culled
    const inferiorSavesList = [];

    // number of cullable saves (non-keep saves)
    const numSaves = this.saves.filter(s => !s.keep).length;

    // iterate through saves (already in order of oldest to newst)
    for (
      let i = 0;
      i < numSaves && numSaves - inferiorSavesList.length > this.numKeepSaves;
      i++
    ) {
      const save = this.saves[i];
      if (!save.keep)
        // ignore a save that is marked as keep
        inferiorSavesList.push(save);
    }

    let removed = 0;

    // delete saves from the inferior saves list
    for (const save of inferiorSavesList) {
      // remove the save from the list of saves
      const index = this.saves.indexOf(save);
      if (index > -1) this.saves.splice(index, 1);

      try {
        // remove the file from fs
        if (Omegga.verbose)
          console.log('Culling autosave', save.name, save.filename);
        rm(save.filename);
        removed++;
      } catch (err) {
        console.error('Error culling autosave', save.filename);
      }
    }
    return removed;
  }

  // get the latest
  getLatestSave() {
    return this.saves.length > 0
      ? this.saves.reduce((a, b) => (a.unix > b.unix ? a : b))
      : undefined;
  }

  // save bricks, resolve when file is moved
  async save() {
    try {
      const promise = new Promise(resolve => {
        // 30 second timeout to check if the autosave failed
        const timeout = setTimeout(() => resolve(false), 30000);
        this.resolve = v => {
          clearTimeout(timeout);
          resolve(v);
        };
      });
      Omegga.saveBricks(TEMP_SAVE_FILENAME);
      return await promise;
    } catch (err) {
      console.error('typical', err);
    }
  }

  // load a save object
  async load(save) {
    console.log('Copying', save.name, 'to temp file');
    await cp(save.filename, this.tempLoadFilePath);
    const file = this.tempLoadFilePath.replace(Omegga.savePath + '/', '');
    Omegga.loadBricks(file);
  }

  // announce a message to the server!.... if it's configured to
  announce(message) {
    if (!this.config['broadcast']) return;
    Omegga.broadcast(message);
  }

  // format a date, show how long ago the date was if it's younger than a week
  formatDate(date) {
    const age = Date.now() - date.getTime();
    return (
      date.toString().replace(/GMT.+/, '') +
      (age < 7 * 24 * 60 * 60 * 1000 ? `(${ago(age)})` : '')
    );
  }

  async handleCommand(name, command, arg) {
    // authorization (host enabled or users in authorized list)
    const player = Omegga.getPlayer(name);
    if (
      this.config['only-authorized'] &&
      !player.isHost() &&
      !this.config['authorized-users'].some(p => player.id === p.id)
    )
      return;

    if (!command) {
      Omegga.whisper(
        name,
        `"${yellow('autosave_ez')} version ${yellow(pkg.version)}"`
      );
      Omegga.whisper(name, '"<b>Usage</>: <code>/asez &lt;command&gt;</>"');
      Omegga.whisper(
        name,
        '"<b>Commands</>: <code>save, list, scan, keep, count</>"'
      );
    }

    // save command
    if (command === 'save') {
      Omegga.broadcast('"Saving"');
      await this.save();
      Omegga.broadcast('"Saved."');

      // list available saves
    } else if (command === 'list') {
      // max page count
      const pages = Math.ceil(this.saves.length / PAGE_SIZE);
      // current page (parse argument as a number, default to 1, cap at page count)
      const page =
        Math.max(
          Math.min(arg && arg.match(/^\d+$/) ? parseInt(arg) : 1, pages),
          1
        ) - 1;
      const offset = page * PAGE_SIZE;

      // save count is nonzero - print out a page from most recent saves first
      if (this.saves.length !== 0) {
        // this code looks like garbages, iterate through the saves at an offset
        // also limit the output
        for (let i = 0; i < PAGE_SIZE && i + offset < this.saves.length; i++) {
          const save = this.saves[this.saves.length - 1 - (i + offset)];
          // print out save id, date, and age
          this.toOne(
            name,
            `"- ${yellow(save.id)} - ${this.formatDate(save.date)}${
              save.keep ? ' - ' + green('KEEP') : ''
            }"`
          );
        }
        // print out pagination info
        this.toOne(
          name,
          `"Page ${yellow(page + 1)} of ${yellow(pages)}. (${yellow(
            this.saves.length
          )} total)"`
        );
      } else {
        this.toOne(name, '"No saves yet"');
      }

      // force re-scan saves
    } else if (command === 'scan') {
      this.saves = this.scanSaves();
      this.toOne(name, `"Found ${yellow(this.saves.length)} saves."`);

      // toggle save as keep
    } else if (command === 'keep') {
      const id = arg && arg.match(/^\d+$/) ? parseInt(arg) : -1;
      const save = this.saves.find(s => s.id === id);

      // check save index
      if (!save) {
        Omegga.broadcast(
          `"Invalid id. Run ${yellow('/asez list')} for a list of save ids."`
        );
        return;
      }

      // check save file existence
      if (!exists(save.filename)) {
        Omegga.broadcast(
          `"Save file does not exist. Run ${yellow(
            '/asez scan'
          )} to update saves."`
        );
        return;
      }

      let newName;
      // toggle filename
      if (save.keep) {
        newName = save.filename.replace(/_keep.brs$/i, '.brs');
      } else {
        newName = save.filename.replace(/.brs$/i, '_keep.brs');
      }

      // modify the file
      try {
        mv(save.filename, newName);
        save.keep = !save.keep;
        save.filename = newName;
        save.name = path.basename(newName);
        this.toOne(
          name,
          `"${save.keep ? green('Enabled') : red('Disabled')} keep on ${yellow(
            save.name
          )}"`
        );
      } catch (err) {
        console.error('Error making file keep', save.filename, err);
        this.toOne(
          name,
          `"${red('Error setting ' + yellow(save.name) + ' to keep')}"`
        );
      }

      // load a save
    } else if (command === 'load') {
      const id = arg && arg.match(/^\d+$/) ? parseInt(arg) : -1;
      const save = this.saves.find(s => s.id === id);

      if (!save) {
        this.toOne(
          name,
          `"Invalid id. Run ${yellow('/asez list')} for a list of save ids."`
        );
        return;
      }

      this.load(save);

      // count bricks by a user
    } else if (command === 'count') {
      const target = (arg || '').toLowerCase();

      if (this.saves.length === 0) {
        this.toOne(
          name,
          `"No autosaves yet. Run ${yellow('/asez save')} to create one."`
        );
        return;
      }

      const save = this.saves[this.saves.length - 1];

      // save relative path
      const relPath = save.filename.replace(Omegga.savePath + '/', '');

      try {
        const data = Omegga.readSaveData(relPath, true);

        // if no target is provided or the autosave does not have header info for brick counts
        if (!target || data.version < 8) {
          this.toOne(
            name,
            `"Latest autosave contains ${yellow(
              data.brick_count.toLocaleString()
            )} bricks from ` +
              `${yellow(data.brick_owners.length.toLocaleString())} owners."`
          );
        } else {
          const exploded = explode(target);
          // lowercase all owners
          for (const p of data.brick_owners) p.nameLower = p.name.toLowerCase();

          const found =
            data.brick_owners.find(p => p.nameLower === target) || // find by exact match
            data.brick_owners.find(p => p.nameLower.indexOf(target) > -1) || // find by rough match
            data.brick_owners.find(p => p.nameLower.match(exploded)); // find by exploded regex match (ck finds cake, tbp finds TheBlackParrot)

          if (!found) {
            this.toOne(name, '"Could not find any player by that name."');
          } else {
            this.toOne(
              name,
              `"Player <link=\\"https://brickadia.com/users/${found.id}\\">${
                found.name
              }</>placed ${yellow(
                found.bricks.toLocaleString()
              )} bricks in the last autosave."`
            );
          }
        }
      } catch (e) {
        console.error('Error reading save', relPath, e);
      }
    }
  }

  async init() {
    // command handling
    Omegga.on('cmd:asez', this.handleCommand.bind(this));
    Omegga.on('chatcmd:asez', this.handleCommand.bind(this));

    // load autosaves on server start
    Omegga.on('start', () => {
      if (this.config['load-on-start']) {
        const latestSave = this.getLatestSave();
        if (latestSave) {
          console.log('Loading latest autosave...');
          this.load(latestSave);
        } else {
          console.log('No autosave to load...');
        }
      }
    });

    // autosave is not enabled, so don't bother watching metrics
    if (!this.config.enabled) return;

    // on heartbeat, check if we should autosave
    Omegga.on('metrics:heartbeat', async status => {
      // detect if the number of bricks has changed since last status update
      // mediocre benchmark when people are changing lights, though you can circumvent this by placing a single brick
      if (
        this.lastBricks !== status.bricks ||
        this.lastComponents !== status.components
      ) {
        this.countChanged = true;
        this.lastComponents = status.components;
        this.lastBricks = status.bricks;
      }

      // cannot save if there are no bricks
      if (status.bricks === 0) {
        return;
      }

      // the latest save is used as a benchmark for when to save
      const latestSave = this.getLatestSave();

      // most recent autosave is sufficiently old or there is no previous autosave
      const isSaveOldEnough =
        !latestSave || latestSave.unix + this.saveInterval < Date.now();

      // server is older than the soonest autosave
      const isServerOldEnough = status.time > this.saveInterval;

      // either the brick count check is disabled or bricks have changed since last save
      const isBricksOk = !this.config['check-brick-count'] || this.countChanged;

      // we should autosave when the server is old enough and the last save is old enough
      if (isSaveOldEnough && isServerOldEnough && isBricksOk) {
        if (this.config['announce-save']) {
          Omegga.broadcast(
            `"Saving ${yellow(status.bricks.toLocaleString())} brick${
              status.bricks !== 1 ? 's' : ''
            }..."`
          );
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        const benchStart = Date.now();
        const ok = await this.save();
        if (!ok) {
          console.error('Autosave failed for some reason, maybe timeout');
          this.announce(`Autosave ${red('failed')}.`);
          // announce autosave failed?
          return;
        }

        // mark the count has not changed as we have just saved bricks
        this.countChanged = false;

        // benchmarked save speed
        const saveSpeed = Math.floor((Date.now() - benchStart) / 10) / 100;
        let culled = 0;
        // announce benchmark and save

        if (this.numKeepSaves > 0) {
          culled = this.cullSaves();
        }

        this.announce(
          `"Auto-saved ${yellow(status.bricks.toLocaleString())} brick${
            status.bricks !== 1 ? 's' : ''
          } in ${yellow(saveSpeed + 's')}.${
            culled > 0
              ? ` Removed ${yellow(culled)} old save${culled !== 1 ? 's' : ''}.`
              : ''
          }"`
        );
      }
    });

    return { registeredCommands: ['asez'] };
  }

  async pluginEvent(event, from) {
    const plugin = await Omegga.getPlugin(from);
    switch (event) {
    case 'connect':
      if (plugin) {
        // if the plugin is already added, overwrite the reference
        const index = this.listeningPlugins.findIndex(p => p.name === from);
        if (index > -1) {
          this.listeningPlugins[index] = plugin;
        } else {
          // otherwise, add it
          this.listeningPlugins.push(plugin);
        }
        console.info('connected to plugin', from);
        plugin.emit('connected', 1);
      }
      break;

    case 'disconnect':
      if (plugin) {
        const index = this.listeningPlugins.findIndex(p => p.name === from);
        // if the plugin exists, remove it from the list
        if (index > -1) {
          this.listeningPlugins[index] = this.listeningPlugins[
            this.listeningPlugins.length - 1
          ];
          this.listeningPlugins.pop();
          console.info('disconnected from plugin', from);
        }
      }
      break;
    }
  }

  emitAll(event, ...args) {
    for (const plugin of this.listeningPlugins) {
      plugin.emit(event, ...args);
    }
  }

  async stop() {
    // tell listening plugins they are no longer connected
    this.emitAll('disconnected');
    this.listeningPlugins = [];
  }
};
