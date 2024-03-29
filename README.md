# easy autosave plugin

An autosaver plugin for [omegga](https://github.com/brickadia-community/omegga).

## Screenshot

![Screenshot of the asez list command](https://i.imgur.com/IsWjkLQ.png)

## Install

Easy: `omegga install gh:Meshiest/autosaveez`

Manual:

- `git clone https://github.com/meshiest/omegga-autosaveez autosaveez` in `plugins` directory
- `npm i` in `autosaveez` directory

## Commands

- `!asez save` - save bricks to an autosave file
- `!asez list [page]` - paginated list of autosaves and their IDs
- `!asez scan` - re-scan autosaves (only do this if you manually modify the files)
- `!asez keep <id>` - mark an autosave as one not to auto-remove
- `!asez load <id>` - load an autosave

## Configs

- `enabled` - Autosave is enabled
- `authorized` - Comma separated list of authorized usernames who can use asez commands
- `host-only` - Whether asez commands are host only
- `folder` - Current folder to place autosaves in + read autosaves from. Leave blank for default `Builds` foler
- `num-saves` - Number of saves to keep (0 means all). Enabling this **will delete oldest autosaves** not marked with `_keep`
- `save-interval` - Minutes between each autosave (minimum 1)
- `autokeep-interval` - Minutes between keep saves to automatically enable keep on latest (0 means disabled). Intended to work with `num-saves` so infinite many keep saves will be stored but limited high frequency saves will not.
- `check-brick-count` - Check brick count to determine if a save should be made
- `load-on-start` - Load latest autosave when server starts
- `filename-format` - Save file name format (requires \$DATE)
- `broadcast` - Announce to the server that an autosave was created
- `announce-save` - Announce to the server that an autosave will be created

## Plugin Interop Methods

Methods you can run to interact with this plugin:

- `connect` - request to be added to events
  - responds with `connected` w/ the plugin api version on success
- `disconnect` - request to be removed from events

## Plugin Interop Events

Events your plugin will receive after running `connect`:

- `save` - sends `path/to/save.brs` - run when asez moves the save file
- `connected` - sends a number indicating plugin version
- `disconnected` - run when this plugin stops and other plugins may need to reconnect
