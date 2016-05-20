'use strict';
const initContext = require('./taskContext');
/*
 * This is a task entry
 * */
module.exports = function(thorin, opt) {
  const logger = thorin.logger(opt.logger),
    PERSIST_KEY = opt.logger + '.startup',
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

  /* Returns the no. of ms of delay at the task startup. */
  function getStartupDelay(taskObj) {
    const persistData = thorin.persist(PERSIST_KEY);
    if (!persistData || typeof persistData[taskObj.name] !== 'number') return 0;
    let now = Date.now(),
      startAfter = persistData[taskObj.name],
      diff = startAfter - now;
    if (diff < 0) diff = 0;
    return diff;
  }

  /* Persists the startup time of a task */
  function setStartupDelay(taskObj, delayMs) {
    let persistData = thorin.persist(PERSIST_KEY);
    if (!persistData) persistData = {};
    persistData[taskObj.name] = Date.now() + delayMs;
    thorin.persist(PERSIST_KEY, persistData);
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
     * Schedules can have:
     *  - delay: '2m'   - the number of seconds to delay
     *  - timer: '10m'
     *    OR
     *  - at: '10:30'
     *
     *  - timeout
     * */
    schedule(actionNames, opt) {
      if (this[schedule]) {
        logger.warn(`schedule() of task ${this.name} already called.`);
        return this;
      }
      if (typeof actionNames === 'string') actionNames = [actionNames];
      if (!(actionNames instanceof Array)) {
        logger.warn(`schedule() of task ${this.name} requires an array of action names.`);
        return this;
      }
      if (typeof opt !== 'object' || !opt) opt = {};
      if (opt.timeout) opt.timeout = getSeconds(opt.timeout);
      if (opt.at) {
        let check = getLaunchAt(opt.at);
        if(check == null) {
          opt.at = null;
        }
      } else {
        if (opt.delay) opt.delay = getSeconds(opt.delay);
        if (opt.timer) opt.timer = getSeconds(opt.timer);
      }
      let fnCalls = [];
      actionNames.forEach((name) => {
        let actionFn = this[actions][name];
        if (typeof actionFn !== 'function') {
          logger.warn(`schedule() of task ${this.name} does not contain action ${name}. Skipping.`);
          return;
        }
        fnCalls.push({
          name,
          fn: actionFn
        });
      });
      if (fnCalls.length === 0) {
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
      if (typeof eventNames === 'string') eventNames = eventNames.split(' ');
      if (!(eventNames instanceof Array)) {
        logger.warn(`handle() of task ${this.name} must contain an event or array of eventNames. Skipping.`);
        return this;
      }
      for (let i = 0; i < eventNames.length; i++) {
        let event = eventNames[i];
        if (typeof event !== 'string') continue;
        if (!this[events][event]) {
          this[events][event] = [];
        }
        this[events][event].push(fn);
      }
      return this;
    }

    /*
     * Starts the task's scheduled actions.
     * */
    start(_delay, _firstStart) {
      if (!this[schedule]) return;
      let item = this[schedule],
        delay,
        self = this;
      if (this[timer]) {
        clearTimeout(this[timer]);
        this[timer] = null;
      }
      if(item.opt.at) { // we have fixed scheduling
        delay = getLaunchAt(item.opt.at);
        let delayStr = getMsTime(delay);
        logger.trace(`Task ${self.name} scheduled to start in ${delayStr}`);
      } else {
        delay = (typeof _delay === 'number' ? _delay : (item.opt.delay ? item.opt.delay * 1000 : 0));
        if (_firstStart) {
          delay += getStartupDelay(this);
        }
      }

      function doCreate() {
        clearTimeout(self[timer]);
        self[timer] = null;
        try {
          self.createContext(item.items, item.opt);
        } catch (e) {
          logger.error(`Failed to create context for task ${this.name}`);
          logger.debug(e);
        }
      }

      delay = parseInt(delay, 10);
      this[timer] = setTimeout(doCreate, delay);
    }

    /*
     * Stops the task.
     * */
    stop(fn) {
      if (this[timer]) clearTimeout(this[timer]);
      this._handleEvent('stop', null, null, () => fn && fn());
    }

    /*
     * Manually runs an action, with an empty context
     * */
    runAction(name) {
      if (typeof this[actions][name] === 'undefined') {
        logger.warn(`runAction() of task ${this.name} does not have action ${name}`);
        return false;
      }
      let contextObj = new TaskContext(this[config]);
      return this[actions][name](contextObj);
    }

    /*
     * Creates a new context and runs it through the actions.
     * */
    createContext(actionNames, opt) {
      let calls = [],
        self = this;
      let contextObj = new TaskContext(this[config]);
      /* step zero: prepare the context. */
      for (let i = 0; i < this[prepares].length; i++) {
        try {
          this[prepares][i](contextObj);
        } catch (e) {
          logger.warn(`prepare() ${i} of task ${this.name} throws an error.`);
          logger.trace(e);
          continue;
        }
      }
      actionNames.forEach((action) => {
        calls.push((stop) => {
          if (contextObj.stopped) return stop();
          return action.fn(contextObj);
        });
      });
      let isDone = false,
        _timeoutTimer = null;

      function onContextTerminated() {
        contextObj.destroy();
        isDone = true;
        if (typeof opt.timer === 'undefined') return;
        let nextDelay = getSeconds(contextObj.delay()) * 1000;
        let timerMs = opt.timer * 1000;
        timerMs += nextDelay;
        if (timerMs <= 0) timerMs = 1;
        setStartupDelay(self, timerMs);
        try {
          self.start(timerMs);
        } catch (e) {
          logger.error(`Could not re-start task ${this.name}`, e);
        }
      }

      if (opt.timeout) {
        _timeoutTimer = setTimeout(() => {
          if (isDone) return;
          isDone = true;
          contextObj.end_at = Date.now();
          contextObj.stop();
          this._handleEvent('timeout', contextObj, null, onContextTerminated);
        }, opt.timeout * 1000);
      }
      thorin.series(calls, (err) => {
        if (_timeoutTimer) clearTimeout(_timeoutTimer);
        if (isDone) return;
        isDone = true;
        contextObj.end_at = Date.now();
        if (err) {
          return this._handleEvent('failed', contextObj, err, onContextTerminated);
        }
        this._handleEvent('completed', contextObj, null, onContextTerminated);
      });
    }

    _hasEvent(event) {
      return (typeof this[events][event] !== 'undefined');
    }

    /*
     * Handles a given event before going to next timer.
     * */
    _handleEvent(event, contextObj, data, done) {
      if (typeof this[events][event] === 'undefined') {
        if (event === 'error') {
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
          } catch (e) {
            logger.warn(`handle() for event ${event} of task ${this.name} throw an error.`);
            logger.trace(e);
            return onEvent();
          }
          if (typeof resObj === 'object' && typeof resObj.then === 'function' && typeof resObj.catch === 'function') {
            resObj.then(() => {
              onEvent();
            }).catch((e) => {
              logger.trace(`handle() for event ${event} of task ${this.name} failed promise with error. ${e.code} - ${e.message}`);
              onEvent();
            })
          } else {
            return onEvent();
          }
        });
      });
      async.series(calls, done);
    }

  }

  /*
   * Returns the number of ms until the target time.
   * Valid time is:
   * hh:mm:ss
   * or
   * hh:mm
   * Ex:
   * 23:30
   * 12:24:50
   * */
  function getLaunchAt(d) {
    let tmp, h, m, s;
    try {
      tmp = d.split(':');
      h = parseInt(tmp[0]);
      m = parseInt(tmp[1]);
      s = parseInt(tmp[2] || 0);
      if (isNaN(h) || isNaN(m) || isNaN(s) || h < 0 || m < 0 || s < 0 || h > 24 || m > 59 || s > 59) {
        throw 1;
      }
    } catch(e) {
      logger.warn(`Schedule at ${d} is not a valid format. Format is hh:mm:ss`);
      return null;
    }
    let now = new Date(),
      currentH = now.getHours(),
      currentM = now.getMinutes(),
      currentS = now.getSeconds();
    if (h < currentH) {          // 2morrow
      h += 24;
    } else if (h === currentH) {
      if (m < currentM) {  // minute has passed, 2morrow
        h += 24;
      } else if (m === currentM) {
        if (s < currentS) {  // seconds passed, 2morrow
          h += 24;
        }
      }
    }
    now.setHours(h);
    now.setMinutes(m);
    now.setSeconds(s);
    let targetTs = now.getTime(),
      currentTs = Date.now();
    return targetTs - currentTs;
  }

  /* Returns the seconds from a string. */
  function getSeconds(val) {
    if (typeof val === 'number') return Math.max(0, val);
    if (typeof val === 'string') {
      let items = val.split(' '),
        total = 0;
      for (let i = 0; i < items.length; i++) {
        var nr = 0,
          str = items[i],
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
        total += nr;
      }
      return total;
    }
    return 0;
  }

  function getMsTime(duration) {
    let milliseconds = parseInt((duration % 1000) / 100)
      , seconds = parseInt((duration / 1000) % 60)
      , minutes = parseInt((duration / (1000 * 60)) % 60)
      , hours = parseInt((duration / (1000 * 60 * 60)) % 24);
    let str = [];
    if (hours > 0) {
      str.push(hours + 'h');
    }
    if (minutes > 0) {
      str.push(minutes + 'm');
    }
    if (seconds > 0) {
      str.push(seconds + 's');
    }
    if (str.length === 0) return 'now';
    return str.join(' ');
  }

  return TaskEntry;
}

