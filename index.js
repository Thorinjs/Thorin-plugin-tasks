'use strict';
const path = require('path'),
  fs = require('fs'),
  initTaskEntry = require('./lib/taskEntry');
/**
 * Created by Adrian on 08-Apr-16.
 *
 * The tasks component is used to schedule various actions that will be executed at specific points in time.
 */
module.exports = function(thorin, opt, pluginName) {
  opt = thorin.util.extend({
    logger: pluginName || 'tasks',
    enabled: true,
    debug: true,
    tasks: {},
    persist: 'config/.task_dump'
  }, opt);
  const pluginObj = {},
    async = thorin.util.async,
    REGISTERED_TASKS = {},
    TaskEntry = initTaskEntry(thorin, opt);

  /*
  * Register a new task.
  * */
  pluginObj.addTask = function(taskName, _opt) {
    if(typeof REGISTERED_TASKS[taskName] !== 'undefined') {
      throw new thorin.error('TASKS.EXISTS', 'The task ' + taskName + ' is already registered.');
    }
    let taskConfig = thorin.util.extend(opt[taskName] || {}, _opt);
    let taskObj = new TaskEntry(taskName, taskConfig);
    REGISTERED_TASKS[taskName] = taskObj;
    process.nextTick(() => {
      // at this point, check any previous timers.
      taskObj.start(undefined, true);
    });
    return taskObj;
  }

  /*
  * Returns a specific task by its name.
  * */
  pluginObj.getTask = function(taskName) {
    return REGISTERED_TASKS[taskName] || null;
  }

  /*
  * Stops all tasks.
  * */
  pluginObj.stopTasks = function StopAllTasks(fn) {
    let calls = [];
    Object.keys(REGISTERED_TASKS).forEach((name) => {
      calls.push(pluginObj.stopTask.bind(pluginObj, name));
    });
    async.series(calls, (e) => fn && fn(e));
  }
  /* Stops a single task. */
  pluginObj.stopTask = function StopTask(name, fn) {
    if(typeof REGISTERED_TASKS[name] === 'undefined') return fn && fn();
    REGISTERED_TASKS[name].stop(fn);
  }

  /*
  * Setup the task plugin
  * */
  pluginObj.setup = function(done) {
    const SETUP_DIRECTORIES = ['app/tasks'];
    for(let i=0; i < SETUP_DIRECTORIES.length; i++) {
      try {
        thorin.util.fs.ensureDirSync(path.normalize(thorin.root + '/' + SETUP_DIRECTORIES[i]));
      } catch(e) {}
    }
    thorin.addIgnore(opt.persist);
    done();
  };

  /*
  * Run the task plugin, loading up all tasks.
  * */
  pluginObj.run = function(done) {
    if(!opt.enabled) return done();
    thorin.loadPath('app/tasks');
    done();
  }


  /* Export the Task class */
  pluginObj.Task = TaskEntry;
  pluginObj.options = opt;
  return pluginObj;
};
module.exports.publicName = 'tasks';