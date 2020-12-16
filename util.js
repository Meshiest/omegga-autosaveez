const fs = require('fs');

// recursively mkdir (mkdir -p )
function mkdir(path) {
  try { fs.mkdirSync(path, {recursive: true}); } catch (e) { /* */ }
}

// remove a file
function rm(path) {
  return new Promise((resolve, reject) => {
    const callback = v => v ? reject(v) : resolve();
    if (fs.existsSync(path))
      fs.unlink(path, callback);
  });
}

// copy a file
async function cp(oldPath, newPath) {
  return new Promise((resolve, reject) => {
    const callback = v => v ? reject(v) : resolve();
    const readStream = fs.createReadStream(oldPath);
    const writeStream = fs.createWriteStream(newPath);

    readStream.on('error', callback);
    writeStream.on('error', callback);

    readStream.on('close', callback);

    readStream.pipe(writeStream);
  });
}

// move a folder to a path
function mv(oldPath, newPath) {
  return new Promise((resolve, reject) => {
    const callback = v => v ? reject(v) : resolve();
    fs.rename(oldPath, newPath, function (err) {
      if (err) {
        if (err.code === 'EXDEV') {
          cp(oldPath, newPath)
            .then(() => fs.unlink(oldPath, callback))
            .catch(reject);
        } else {
          callback(err);
        }
        return;
      }
      callback();
    });
  });
}

function ago(time) {
  if (time < 0) return 'not yet';
  time /= 1000;

  if (time < 5) return 'a moment';
  if (time < 60) return Math.round(time) + ' secs';
  time /= 60;
  if (time < 60) return Math.round(time) + ' mins';
  time /= 60;
  if (time < 24) return Math.round(time) + ' hours';
  time /= 24;
  return Math.round(time) + ' days';
}

module.exports = {
  mkdir, mv, cp, rm, ago,
  exists: path => fs.existsSync(path),
};