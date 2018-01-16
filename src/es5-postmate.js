(function () {
    'use strict';
    /**
     * The type of messages our frames our sending
     * @type {String}
     */
    var MESSAGE_TYPE = 'application/x-postmate-v1+json';

    /**
     * hasOwnProperty()
     * @type {Function}
     * @return {Boolean}
     */
    var hasOwnProperty = Object.prototype.hasOwnProperty;

    /**
     * The maximum number of attempts to send a handshake request to the parent
     * @type {Number}
     */
    var maxHandshakeRequests = 50;

    /**
     * A unique message ID that is used to ensure responses are sent to the correct requests
     * @type {Number}
     */
    var _messageId = 0;

    /**
     * Increments and returns a message ID
     * @return {Number} A unique ID for a message
     */
    function messageId() {
        return ++_messageId;
    }

    /**
     * Check the version of broswer is less than ie9
     */
    function isLessThanIe9() {
        var $test = $('<b></b>').html('<!--[if IE lte 9]><i></i><![endif]-->');
        var count = $test.find('i').length;
        var ie = count === 1;
        $test.remove();
        return ie;
    }

    function serialize(data) {
        data = data || {};
        if (isLessThanIe9()) {
            return JSON.stringify(data);
        }
        return data;
    }

    function deserialize(data) {
        if (isLessThanIe9()) {
            data = data || '{}';
            return JSON.parse(data);
        }
        return data;
    }

    /**
     * Postmate logging function that enables/disables via config
     * @param  {Object} ...args Rest Arguments
     */
    function log() {
        if (!Postmate.debug) return;
        console.log(); // eslint-disable-line no-console
    }

    /**
     * Takes a URL and returns the origin
     * @param  {String} url The full URL being requested
     * @return {String}     The URLs origin
     */
    function resolveOrigin(url) {
        var a = document.createElement('a');
        a.href = url;
        return a.origin || a.protocol + '//' + a.hostname + ':' + a.port;
    }

    /**
     * Ensures that a message is safe to interpret
     * @param  {Object} message       The postmate message being sent
     * @param  {String} allowedOrigin The whitelisted origin
     * @return {Boolean}
     */
    function sanitize(message, allowedOrigin) {
        var eventData = deserialize(message.data);
        if (message.origin !== allowedOrigin) return false;
        if (typeof eventData !== 'object') return false;
        if (!('postmate' in eventData)) return false;
        if (eventData.type !== MESSAGE_TYPE) return false;
        if (!{
                'handshake-reply': 1,
                call: 1,
                emit: 1,
                reply: 1,
                request: 1,
            }[eventData.postmate]) return false;
        return true;
    }

    /**
     * Takes a model, and searches for a value by the property
     * @param  {Object} model     The dictionary to search against
     * @param  {String} property  A path within a dictionary (i.e. 'window.location.href')
     * @param  {Object} data      Additional information from the get request that is
     *                            passed to functions in the child model
     * @return {Promise}
     */
    function resolveValue(model, property) {
        var unwrappedContext = typeof model[property] === 'function' ?
            model[property]() : model[property];
        return Postmate.Promise.resolve(unwrappedContext);
    }

    /**
     * Composes an API to be used by the parent
     * @param {Object} info Information on the consumer
     */
    function ParentAPI(info) {
        var self = this;
        this.parent = info.parent;
        this.frame = info.frame;
        this.child = info.child;
        this.childOrigin = info.childOrigin;

        this.events = {};

        log('Parent: Registering API');
        log('Parent: Awaiting messages...');

        this.listener = function (e) {
            var eventData = deserialize((e || {}).data);
            var data = (eventData.value || {}).data;
            var name = (eventData.value || {}).name;
            if (eventData.postmate === 'emit') {
                log('Parent: Received event emission: ' + name);
                if (name in self.events) {
                    self.events[name].call(self, data);
                }
            }
        };

        this.parent.addEventListener('message', this.listener, false);
        log('Parent: Awaiting event emissions from Child');

        this.get = function (property) {
            return new Postmate.Promise(function (resolve) {
                // Extract data from response and kill listeners
                var uid = messageId();
                var transact = function (e) {
                    var eventData = deserialize(e.data);
                    if (eventData.uid === uid && eventData.postmate === 'reply') {
                        self.parent.removeEventListener('message', transact, false);
                        resolve(eventData.value);
                    }
                };

                // Prepare for response from Child...
                self.parent.addEventListener('message', transact, false);

                // Then ask child for information
                var toPostData = serialize({
                    postmate: 'request',
                    type: MESSAGE_TYPE,
                    property: property,
                    uid: uid,
                });
                self.child.postMessage(toPostData, self.childOrigin);
            });
        };

        this.call = function (property, data) {
            // Send information to the child
            self.child.postMessage(serialize({
                postmate: 'call',
                type: MESSAGE_TYPE,
                property: property,
                data: data,
            }), self.childOrigin);
        };

        this.on = function (eventName, callback) {
            self.events[eventName] = callback;
        };

        this.destroy = function () {
            log('Parent: Destroying Postmate instance');
            window.removeEventListener('message', self.listener, false);
            self.frame.parentNode.removeChild(self.frame);
        };
    }

    /**
     * Composes an API to be used by the child
     * @param {Object} info Information on the consumer
     */
    function ChildAPI(info) {
        var self = this;
        this.model = info.model;
        this.parent = info.parent;
        this.parentOrigin = info.parentOrigin;
        this.child = info.child;

        log('Child: Registering API');
        log('Child: Awaiting messages...');

        this.child.addEventListener('message', function (e) {
            if (!sanitize(e, self.parentOrigin)) return;
            log('Child: Received request', e.data);
            var eventData = deserialize(e.data);
            var property = eventData.property;
            var uid = eventData.uid;
            var data = eventData.data;

            if (eventData.postmate === 'call') {
                if (property in self.model && typeof self.model[property] === 'function') {
                    self.model[property].call(self, data);
                }
                return;
            }

            // Reply to Parent
            resolveValue(self.model, property)
                .then(function (value) {
                    e.source.postMessage(serialize({
                        property: property,
                        postmate: 'reply',
                        type: MESSAGE_TYPE,
                        uid: uid,
                        value: value,
                    }), e.origin);
                });
        });

        this.emit = function (name, data) {
            log('Child: Emitting Event "' + name + '"', data);
            self.parent.postMessage(serialize({
                postmate: 'emit',
                type: MESSAGE_TYPE,
                value: {
                    name: name,
                    data: data,
                },
            }), self.parentOrigin);
        };
    }

    /**
     * Sets options related to the Parent
     * @param {Object} userOptions The element to inject the frame into, and the url
     * @return {Promise}
     */
    function Postmate(userOptions) {
        var self = this;
        var container = typeof container !== 'undefined' ? container : document.body;
        if (userOptions.container) {
            container = userOptions.container;
        }
        var model = userOptions.model;
        var url = userOptions.url;
        this.parent = window;
        this.frame = document.createElement('iframe');
        container.appendChild(this.frame);
        this.child = this.frame.contentWindow || this.frame.contentDocument.parentWindow;
        this.model = model || {};

        /**
         * Begins the handshake strategy
         * @param  {String} url The URL to send a handshake request to
         * @return {Promise}     Promise that resolves when the handshake is complete
         */
        this.sendHandshake = function (url) {
            var childOrigin = resolveOrigin(url);
            var attempt = 0;
            var responseInterval;
            return new Postmate.Promise(function (resolve, reject) {
                var reply = function (e) {
                    if (!sanitize(e, childOrigin)) return false;
                    var eventData = deserialize(e.data);
                    if (eventData.postmate === 'handshake-reply') {
                        clearInterval(responseInterval);
                        log('Parent: Received handshake reply from Child');
                        self.parent.removeEventListener('message', reply, false);
                        self.childOrigin = e.origin;
                        log('Parent: Saving Child origin', self.childOrigin);
                        return resolve(new ParentAPI(self));
                    }

                    // Might need to remove since parent might be receiving different messages
                    // from different hosts
                    log('Parent: Invalid handshake reply');
                    return reject('Failed handshake');
                };

                self.parent.addEventListener('message', reply, false);

                var doSend = function () {
                    attempt++;
                    log('Parent: Sending handshake attempt ' + attempt, {
                        childOrigin: childOrigin
                    });
                    self.child.postMessage(serialize({
                        postmate: 'handshake',
                        type: MESSAGE_TYPE,
                        model: self.model,
                    }), childOrigin);

                    if (attempt === maxHandshakeRequests) {
                        clearInterval(responseInterval);
                    }
                };

                var loaded = function () {
                    doSend();
                    responseInterval = setInterval(doSend, 500);
                };

                if (self.frame.attachEvent) {
                    self.frame.attachEvent('onload', loaded);
                } else {
                    self.frame.onload = loaded;
                }

                log('Parent: Loading frame', {
                    url: url
                });
                self.frame.src = url;
            });
        };

        return this.sendHandshake(url);
    }

    window.Postmate = Postmate;
    window.Postmate.debug = false;
    window.Postmate.Promise = (function () {
        try {
            return window ? window.Promise : Promise;
        } catch (e) {
            return null;
        }
    })();
    Postmate.Model = function Model(model) {
        var self = this;
        this.child = window;
        this.model = model;
        this.parent = this.child.parent;

        /**
         * Responds to a handshake initiated by the Parent
         * @return {Promise} Resolves an object that exposes an API for the Child
         */
        this.sendHandshakeReply = function () {
            return new Postmate.Promise(function (resolve, reject) {
                var shake = function (e) {
                    var eventData = deserialize(e.data);
                    if (!eventData.postmate) {
                        return;
                    }
                    if (eventData.postmate === 'handshake') {
                        log('Child: Received handshake from Parent');
                        self.child.removeEventListener('message', shake, false);
                        log('Child: Sending handshake reply to Parent');
                        e.source.postMessage(serialize({
                            postmate: 'handshake-reply',
                            type: MESSAGE_TYPE,
                        }), e.origin);
                        self.parentOrigin = e.origin;

                        // Extend model with the one provided by the parent
                        var defaults = eventData.model;
                        if (defaults) {
                            var keys = Object.keys(defaults);
                            for (var i = 0; i < keys.length; i++) {
                                if (hasOwnProperty.call(defaults, keys[i])) {
                                    self.model[keys[i]] = defaults[keys[i]];
                                }
                            }
                            log('Child: Inherited and extended model from Parent');
                        }

                        log('Child: Saving Parent origin', self.parentOrigin);
                        setTimeout(function () {
                            resolve(new ChildAPI(self));
                        }, 10);
                        return;
                    }
                    return reject('Handshake Reply Failed');
                };
                self.child.addEventListener('message', shake, false);
            });
        };

        return this.sendHandshakeReply();
    };
})();