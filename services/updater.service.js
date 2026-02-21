
const { spawn } = require('child_process');
const path = require('path');

class UpdaterService {
  constructor(io) {
    this.io = io;
  }

  runUpdate() {
    return new Promise((resolve, reject) => {
      const scriptPath = path.resolve(process.cwd(), './takportal');

      const updateProcess = spawn(scriptPath, ['update'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: process.env,
      });

      updateProcess.stdout.on('data', (data) => {
        const message = data.toString();
        console.log(message);
        if (this.io) {
          this.io.emit('update-log', message);
        }
      });

      updateProcess.stderr.on('data', (data) => {
        const message = data.toString();
        console.error(message);
        if (this.io) {
          this.io.emit('update-log', message);
        }
      });

      updateProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, message: 'Update completed successfully.' });
        } else {
          reject(new Error(`Update failed with exit code ${code}`));
        }
      });

      updateProcess.on('error', (err) => {
        reject(err);
      });
    });
  }
}

module.exports = UpdaterService;
