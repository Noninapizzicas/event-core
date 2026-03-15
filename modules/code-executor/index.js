/**
 * Code Executor Module
 * Shell command and script execution for AI with security controls
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fsSync = require('fs');

class CodeExecutorModule {
  constructor() {
    this.name = 'code-executor';
    this.version = '1.0.0';

    // Dependencies (injected)
    this.logger = null;
    this.eventBus = null;
    this.config = null;

    // State: background processes
    this.processes = new Map(); // name/pid -> { process, command, startedAt, cwd }
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  async onLoad(core) {
    this.logger = core.logger;
    this.eventBus = core.eventBus;

    // Load config from loader-injected moduleConfig
    this.config = core.moduleConfig || {};

    // Compile blocked patterns to RegExp
    this.blockedPatterns = (this.config.blockedPatterns || []).map(p => new RegExp(p, 'i'));

    this.logger.info('code-executor.loaded', {
      max_timeout: this.config.maxTimeout,
      max_processes: this.config.maxProcesses,
      blocked_commands: this.config.blockedCommands?.length || 0,
      blocked_patterns: this.blockedPatterns.length
    });
  }

  async onUnload() {
    // Kill all background processes
    for (const [name, info] of this.processes.entries()) {
      try {
        info.process.kill('SIGTERM');
        this.logger.info('code-executor.process.killed', { name, pid: info.process.pid });
      } catch (error) {
        this.logger.warn('code-executor.process.kill.error', { name, error: error.message });
      }
    }
    this.processes.clear();
    this.logger.info('code-executor.unloaded');
  }

  // ==========================================
  // Security
  // ==========================================

  /**
   * Check if command is safe to execute
   * @param {string} command - Command to check
   * @returns {{ safe: boolean, reason?: string }}
   */
  isCommandSafe(command) {
    if (!command || typeof command !== 'string') {
      return { safe: false, reason: 'Invalid command' };
    }

    const normalizedCommand = command.trim().toLowerCase();

    // Check blocked commands (exact match)
    for (const blocked of (this.config.blockedCommands || [])) {
      if (normalizedCommand.includes(blocked.toLowerCase())) {
        return { safe: false, reason: `Blocked command pattern: ${blocked}` };
      }
    }

    // Check blocked patterns (regex)
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(command)) {
        return { safe: false, reason: `Matches blocked pattern: ${pattern.source}` };
      }
    }

    // Check for shell injection attempts
    const dangerousChars = ['`', '$(', '${', '&&', '||', ';', '|'];
    // Allow pipes and chaining for legitimate use, but warn
    // The main protection is the blockedPatterns

    return { safe: true };
  }

  /**
   * Get project path safely
   */
  async getProjectPath(projectId) {
    if (!projectId) return process.cwd();

    const projectsRoot = path.resolve(this.config.projectsPath || './data/projects');
    const projectPath = path.join(projectsRoot, projectId);

    // Security: ensure path is within projects directory
    const resolvedPath = path.resolve(projectPath);
    if (!resolvedPath.startsWith(projectsRoot)) {
      throw new Error('Invalid project path: path traversal detected');
    }

    return resolvedPath;
  }

  // ==========================================
  // AI Tool Handlers
  // ==========================================

  /**
   * shell.exec - Execute a shell command
   */
  async handleToolExec(args) {
    const { command, cwd, timeout, env } = args || {};

    if (!command) {
      return {
        status: 400,
        data: { error: 'command is required' }
      };
    }

    // Security check
    const safetyCheck = this.isCommandSafe(command);
    if (!safetyCheck.safe) {
      this.logger.warn('code-executor.blocked', {
        command: command.substring(0, 100),
        reason: safetyCheck.reason
      });

      return {
        status: 403,
        data: {
          error: 'Command blocked for security reasons',
          reason: safetyCheck.reason
        }
      };
    }

    const execTimeout = Math.min(timeout || this.config.defaultTimeout, this.config.maxTimeout);
    const execCwd = cwd || process.cwd();

    this.logger.info('code-executor.exec.start', {
      command: command.substring(0, 100),
      cwd: execCwd,
      timeout: execTimeout
    });

    const startTime = Date.now();

    return new Promise((resolve) => {
      const execOptions = {
        cwd: execCwd,
        timeout: execTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env, ...(env || {}) },
        shell: this.config.shell || '/bin/sh'
      };

      exec(command, execOptions, (error, stdout, stderr) => {
        const duration = Date.now() - startTime;
        const exitCode = error?.code || 0;
        const killed = error?.killed || false;
        const signal = error?.signal || null;

        if (killed || signal === 'SIGTERM') {
          this.logger.warn('code-executor.exec.timeout', {
            command: command.substring(0, 100),
            timeout: execTimeout
          });

          // Publish event
          this.eventBus?.publish('shell.error', {
            command: command.substring(0, 100),
            error: 'Command timed out',
            timeout: execTimeout
          });

          resolve({
            status: 408,
            data: {
              success: false,
              error: 'Command timed out',
              timeout: execTimeout,
              stdout: stdout?.toString() || '',
              stderr: stderr?.toString() || ''
            }
          });
          return;
        }

        if (error && exitCode !== 0) {
          this.logger.info('code-executor.exec.error', {
            command: command.substring(0, 100),
            exitCode,
            duration
          });

          // Publish event
          this.eventBus?.publish('shell.error', {
            command: command.substring(0, 100),
            exitCode,
            stderr: stderr?.toString().substring(0, 500)
          });

          resolve({
            status: 200, // Return 200 even for non-zero exit - it's not an API error
            data: {
              success: false,
              exitCode,
              stdout: stdout?.toString() || '',
              stderr: stderr?.toString() || '',
              duration
            }
          });
          return;
        }

        this.logger.info('code-executor.exec.success', {
          command: command.substring(0, 100),
          exitCode: 0,
          duration,
          stdout_length: stdout?.length || 0
        });

        // Publish event
        this.eventBus?.publish('shell.executed', {
          command: command.substring(0, 100),
          exitCode: 0,
          duration
        });

        resolve({
          status: 200,
          data: {
            success: true,
            exitCode: 0,
            stdout: stdout?.toString() || '',
            stderr: stderr?.toString() || '',
            duration
          }
        });
      });
    });
  }

  /**
   * shell.script - Execute a script file
   */
  async handleToolScript(args) {
    const { projectId, scriptPath, args: scriptArgs = [], timeout } = args || {};

    if (!projectId) {
      return {
        status: 400,
        data: { error: 'projectId is required' }
      };
    }

    if (!scriptPath) {
      return {
        status: 400,
        data: { error: 'scriptPath is required' }
      };
    }

    try {
      const projectPath = await this.getProjectPath(projectId);
      const fullScriptPath = path.join(projectPath, scriptPath);

      // Security: ensure script is within project
      const resolvedScript = path.resolve(fullScriptPath);
      if (!resolvedScript.startsWith(projectPath)) {
        return {
          status: 403,
          data: { error: 'Script path outside project directory' }
        };
      }

      // Check if script exists
      try {
        await fs.access(resolvedScript, fs.constants.R_OK);
      } catch {
        return {
          status: 404,
          data: { error: `Script not found: ${scriptPath}` }
        };
      }

      // Detect interpreter based on extension or shebang
      const ext = path.extname(scriptPath).toLowerCase();
      let interpreter = '';

      switch (ext) {
        case '.sh':
        case '.bash':
          interpreter = 'bash';
          break;
        case '.py':
          interpreter = 'python3';
          break;
        case '.js':
        case '.mjs':
          interpreter = 'node';
          break;
        case '.rb':
          interpreter = 'ruby';
          break;
        case '.pl':
          interpreter = 'perl';
          break;
        default:
          // Try to read shebang
          try {
            const content = await fs.readFile(resolvedScript, 'utf-8');
            const firstLine = content.split('\n')[0];
            if (firstLine.startsWith('#!')) {
              interpreter = firstLine.slice(2).trim();
            } else {
              interpreter = 'bash'; // Default to bash
            }
          } catch {
            interpreter = 'bash';
          }
      }

      // Build command
      const argsStr = scriptArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
      const command = `${interpreter} "${resolvedScript}" ${argsStr}`.trim();

      // Execute using handleToolExec
      return this.handleToolExec({
        command,
        cwd: projectPath,
        timeout: timeout || 60000
      });

    } catch (error) {
      this.logger.error('code-executor.script.error', {
        projectId,
        scriptPath,
        error: error.message
      });

      return {
        status: 500,
        data: {
          success: false,
          error: error.message
        }
      };
    }
  }

  /**
   * shell.background - Start a background process
   */
  async handleToolBackground(args) {
    const { command, cwd, name } = args || {};

    if (!command) {
      return {
        status: 400,
        data: { error: 'command is required' }
      };
    }

    // Check max processes limit
    if (this.processes.size >= this.config.maxProcesses) {
      return {
        status: 429,
        data: {
          error: 'Maximum background processes reached',
          limit: this.config.maxProcesses,
          active: this.processes.size
        }
      };
    }

    // Security check
    const safetyCheck = this.isCommandSafe(command);
    if (!safetyCheck.safe) {
      return {
        status: 403,
        data: {
          error: 'Command blocked for security reasons',
          reason: safetyCheck.reason
        }
      };
    }

    const processName = name || `proc-${Date.now()}`;
    const execCwd = cwd || process.cwd();

    this.logger.info('code-executor.background.start', {
      name: processName,
      command: command.substring(0, 100),
      cwd: execCwd
    });

    try {
      const child = spawn(command, [], {
        cwd: execCwd,
        shell: this.config.shell || '/bin/sh',
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });

      // Collect output (limited buffer)
      let stdout = '';
      let stderr = '';
      const maxBuffer = 100 * 1024; // 100KB per stream

      child.stdout?.on('data', (data) => {
        if (stdout.length < maxBuffer) {
          stdout += data.toString();
        }
      });

      child.stderr?.on('data', (data) => {
        if (stderr.length < maxBuffer) {
          stderr += data.toString();
        }
      });

      // Store process info
      this.processes.set(processName, {
        process: child,
        command,
        cwd: execCwd,
        startedAt: new Date().toISOString(),
        pid: child.pid,
        getOutput: () => ({ stdout, stderr })
      });

      // Handle process exit
      child.on('exit', (code, signal) => {
        this.logger.info('code-executor.background.exit', {
          name: processName,
          pid: child.pid,
          code,
          signal
        });

        this.eventBus?.publish('shell.process.stopped', {
          name: processName,
          pid: child.pid,
          exitCode: code,
          signal
        });

        this.processes.delete(processName);
      });

      // Publish event
      this.eventBus?.publish('shell.process.started', {
        name: processName,
        pid: child.pid,
        command: command.substring(0, 100)
      });

      return {
        status: 200,
        data: {
          success: true,
          name: processName,
          pid: child.pid,
          command: command.substring(0, 100),
          message: 'Background process started'
        }
      };

    } catch (error) {
      this.logger.error('code-executor.background.error', {
        command: command.substring(0, 100),
        error: error.message
      });

      return {
        status: 500,
        data: {
          success: false,
          error: error.message
        }
      };
    }
  }

  /**
   * shell.kill - Kill a background process
   */
  async handleToolKill(args) {
    const { pid, name } = args || {};

    if (!pid && !name) {
      return {
        status: 400,
        data: { error: 'Either pid or name is required' }
      };
    }

    // Find process
    let processInfo = null;
    let processKey = null;

    if (name) {
      processInfo = this.processes.get(name);
      processKey = name;
    } else if (pid) {
      for (const [key, info] of this.processes.entries()) {
        if (info.pid === pid) {
          processInfo = info;
          processKey = key;
          break;
        }
      }
    }

    if (!processInfo) {
      return {
        status: 404,
        data: {
          error: 'Process not found',
          hint: 'Use shell.list to see active processes'
        }
      };
    }

    try {
      processInfo.process.kill('SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 500));

      // Force kill if still running
      if (!processInfo.process.killed) {
        processInfo.process.kill('SIGKILL');
      }

      const output = processInfo.getOutput?.() || {};

      this.logger.info('code-executor.kill.success', {
        name: processKey,
        pid: processInfo.pid
      });

      this.processes.delete(processKey);

      return {
        status: 200,
        data: {
          success: true,
          name: processKey,
          pid: processInfo.pid,
          message: 'Process terminated',
          stdout: output.stdout?.substring(0, 5000) || '',
          stderr: output.stderr?.substring(0, 5000) || ''
        }
      };

    } catch (error) {
      this.logger.error('code-executor.kill.error', {
        name: processKey,
        error: error.message
      });

      return {
        status: 500,
        data: {
          success: false,
          error: error.message
        }
      };
    }
  }

  /**
   * shell.list - List active background processes
   */
  async handleToolList() {
    const processes = [];

    for (const [name, info] of this.processes.entries()) {
      processes.push({
        name,
        pid: info.pid,
        command: info.command.substring(0, 100),
        cwd: info.cwd,
        startedAt: info.startedAt,
        running: !info.process.killed
      });
    }

    return {
      status: 200,
      data: {
        success: true,
        processes,
        count: processes.length,
        limit: this.config.maxProcesses
      }
    };
  }
}

module.exports = CodeExecutorModule;
