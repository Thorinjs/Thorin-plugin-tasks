'use strict';
const path = require('path'),
  fs = require('fs'),
  initTaskEntry = require('./lib/taskEntry');
/**
 * Created by Adrian on 08-Apr-16.
 *
 * The less plugin is a utility plugin that will watch the given less input for changes and compile it into css.
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
      taskObj.start();
    });
    return taskObj;
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