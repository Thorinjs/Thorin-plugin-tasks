'use strict';
const initContext = require('./taskContext');
/*
 * This is a task entry
 * */
module.exports = function(thorin, opt) {
  const logger = thorin.logger(opt.logger),
    async = thorin.util.async,
    config = Symbol(),
    prepares = Symbol(),
    actions = Symbol(),
    schedule = Symbol(),
    starts = Symbol(),
    timer = Symbol(),
    events = Symbol();

  const TaskContext = initContext(thorin, opt);

  const EVENTS = {
    FAILED: 'failed',
    COMPLETED: 'completed',
    TIMEOUT: 'timeout',
    STOP: 'stop'
  }

  class TaskEntry {

    constructor(name, opt) {
      this.name = name;
      this[config] = opt;
      this[prepares] = [];
      this[actions] = {};
      this[schedule] = null;
      this[events] = {};
      this[starts] = [];
      this[timer] = null;
    }

    /*
     * Registers a prepare callback to be called before we start the task.
     * */
    prepare(fn) {
      this[prepares].push(fn);
      return this;
    }

    /*
     * Registers a new action.
     * */
    action(name, fn) {
      if (typeof this[actions][name] !== 'undefined') {
        logger.error(`Action ${name} of task ${this.name} already exists. Skipping.`);
        return this;
      }
      this[actions][name] = fn;
      return this;
    }

    /*
     * Schedule a new task to be executed with the given options.
     * */
    schedule(actionNames, opt) {
      if(this[schedule]) {
        logger.warn(`schedule() of task ${this.name} already called.`);
        return this;
      }
      if (typeof actionNames === 'string') actionNames = [actionNames];
      if (!(actionNames instanceof Array)) {
        logger.warn(`schedule() of task ${this.name} requires an array of action names.`);
        return this;
      }
      if (typeof opt !== 'object' || !opt) opt = {};
      if (opt.delay) opt.delay = getSeconds(opt.delay);
      if (opt.timeout) opt.timeout = getSeconds(opt.timeout);
      if (opt.timer) opt.timer = getSeconds(opt.timer);
      let fnCalls = [];
      actionNames.forEach((name) => {
        let actionFn = this[actions][name];
        if(typeof actionFn !== 'function') {
          logger.warn(`schedule() of task ${this.name} does not contain action ${name}. Skipping.`);
          return;
        }
        fnCalls.push({
          name,
          fn: actionFn
        });
      });
      if(fnCalls.length === 0) {
        logger.warn(`schedule() of task ${this.name} contains no actions. Skipping.`);
        return this;
      }
      let scheduleItem = {
        opt,
        items: fnCalls
      };
      this[schedule] = scheduleItem;
      return this;
    }

    /*
    * Register a handler for the given event or events.
    * */
    handle(eventNames, fn) {
      if(typeof eventNames === 'string') eventNames = eventNames.split(' ');
      if(!(eventNames instanceof Array)) {
        logger.warn(`handle() of task ${this.name} must contain an event or array of eventNames. Skipping.`);
        return this;
      }
      for(let i=0; i < eventNames.length; i++) {
        let event = eventNames[i];
        if(typeof event !== 'string') continue;
        if(!this[events][event]) {
          this[events][event] = [];
        }
        this[events][event].push(fn);
      }
      return this;
    }

    /*
    * Starts the task's scheduled actions.
    * */
    start(_delay) {
      if(!this[schedule]) return;
      let item = this[schedule];
      if(this[timer]) clearTimeout(this[timer]);
      let delay = (typeof _delay === 'number' ? _delay : (item.opt.delay ? item.opt.delay * 1000 : 0));
      this[timer] = setTimeout(() => {
        this.createContext(item.items, item.opt);
      }, delay);
    }

    /*
    * Creates a new context and runs it through the actions.
    * */
    createContext(actionNames, opt) {
      let calls = [];
      let contextObj = new TaskContext(this[config]);
      /* step zero: prepare the context. */
      for(let i=0; i < this[prepares].length; i++) {
        try {
          this[prepares][i](contextObj);
        } catch(e) {
          logger.warn(`prepare() ${i} of task ${this.name} throws an error.`);
          logger.trace(e);
          continue;
        }
      }
      actionNames.forEach((action) => {
        calls.push(() => {
          if(contextObj.stopped) return;
          return action.fn(contextObj);
        });
      });
      let isDone = false,
        self = this,
        _timeoutTimer = null;

      function onContextTerminated() {
        contextObj.destroy();
        isDone = true;
        if(!opt.timer) return;
        let nextDelay = getSeconds(contextObj.delay()) * 1000;
        let timerMs = opt.timer * 1000;
        timerMs += nextDelay;
        if(timerMs <= 0) timerMs = 1;
        self.start(timerMs);
      }
      if(opt.timeout) {
        _timeoutTimer = setTimeout(() => {
          if(isDone) return; isDone = true;
          contextObj.end_at = Date.now();
          contextObj.stop();
          this._handleEvent('timeout', contextObj, null, onContextTerminated);
        }, opt.timeout * 1000);
      }
      thorin.series(calls, (err) => {
        if(isDone) return; isDone = true;
        contextObj.end_at = Date.now();
        if(_timeoutTimer) clearTimeout(_timeoutTimer);
        if(err) {
          return this._handleEvent('failed', contextObj, err, onContextTerminated);
        }
        this._handleEvent('completed', contextObj, null, onContextTerminated);
      });
    }

    _hasEvent(event) {
      if(typeof this[events][event] !== 'undefined');
    }

    /*
    * Handles a given event before going to next timer.
    * */
    _handleEvent(event, contextObj, data, done) {
      if(typeof this[events][event] === 'undefined') {
        if(event === 'error') {
          logger.warn(`Task ${this.name} encountered an error: ${data.code} - ${data.message}`);
        }
        return done();
      }
      const calls = [];
      this[events][event].forEach((fn) => {
        calls.push((onEvent) => {
          let resObj;
          try {
            resObj = fn(contextObj, data);
          } catch(e) {
            logger.warn(`handle() for event ${event} of task ${this.name} throw an error.`);
            logger.trace(e);
            done();
          }
          if(typeof resObj === 'object' && typeof resObj.then === 'function' && typeof resObj.catch === 'function') {
            resObj.then(() => {
              done();
            }).catch((e) => {
              logger.trace(`handle() for event ${event} of task ${this.name} failed promise with error. ${e.code} - ${e.message}`);
              done();
            })
          } else {
            return done();
          }
        });
      });
      async.series(calls, done);
    }

  }

  /* Returns the seconds from a string. */
  function getSeconds(str) {
    if (typeof str === 'number') return Math.max(0, str);
    if (typeof str === 'string') {
      var nr = 0,
        mul = 1,
        type;
      if (str.indexOf('s') !== -1) {
        type = 's';
      }
      if (str.indexOf('m') !== -1) {
        type = 'm';
        mul = 60;
      }
      if (str.indexOf('h') !== -1) {
        type = 'h';
        mul = 3600;
      }
      if (str.indexOf('d') !== -1) {
        type = 'd';
        mul = 86400;
      }
      if (!type) return 0;
      nr = parseInt(str.replace(type, ''), 10);
      nr = nr * mul;
      return nr;
    }
    return 0;
  }


  return TaskEntry;
}