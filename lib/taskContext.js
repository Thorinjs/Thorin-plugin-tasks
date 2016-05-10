'use strict';
const EventEmitter = require('events').EventEmitter;
/**
 * Created by Adrian on 10-May-16.
 */
module.exports = function(thorin, opt) {

  const delay = Symbol();

  class TaskContext extends EventEmitter {

    constructor(config) {
      super();
      this.start_at = Date.now();
      this.end_at = null;
      this.stopped = false;
      this.config = config;
      this.error = null;
    }

    took() {
      if(!this.end_at) return 0;
      return (this.end_at - this.start_at);
    }

    stop() {
      this.stopped = true;
      return this;
    }

    destroy() {
      Object.keys(this).forEach((k) => {
        delete this[k];
      });
    }

    /*
    * Delays the current context with the given number of seconds.
    * */
    delay(sec) {
      if(typeof sec === 'undefined') return this[delay] || 0;
      this[delay] = sec;
      return this;
    }

  }

  return TaskContext;
}