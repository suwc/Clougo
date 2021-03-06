//-------------------------------------------------------------------------------------------------------
// Copyright (C) Clougo Project. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//-------------------------------------------------------------------------------------------------------

"use strict";

var $classObj = {};
$classObj.create = function(isNodeJsEnvFlag, util) {
    const sys = {};

    sys.util = util;

    function isNodeJsEnv() {
        return !!isNodeJsEnvFlag;
    }
    sys.isNodeJsEnv = isNodeJsEnv;

    function getCleartextChar() {
        return "\x1Bc";
    }
    sys.getCleartextChar = getCleartextChar;

    function isUndefined(v) {
        return v === undefined;
    }
    sys.isUndefined = isUndefined;

    sys.isInteger = Number.isInteger || function isInteger(x) {
        return (typeof x === "number") && (x % 1 === 0);
    };

    function emptyStringIfUndefined(v) {
        return isUndefined(v) ? "" : v;
    }
    sys.emptyStringIfUndefined = emptyStringIfUndefined;

    function makeMatchListRegexp(v) {
        assert(Array.isArray(v));
        return new RegExp(
            "(" + v.map(
                function (v) {
                    return v.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                }
            ).join("|") + ")");
    }
    sys.makeMatchListRegexp = makeMatchListRegexp;

    function equalToken(val1, val2) {
        return (val2 === val1) || ((typeof val1 === "string" && typeof val2 === "string") &&
            val2.toLowerCase() === val1.toLowerCase());
    }
    sys.equalToken = equalToken;

    function assert(cond, msg) {
        if (!cond) {
            throw Error(msg);
        }
    }
    sys.assert = assert;

    function logoFround6(num) {
        return Math.round(num * 1e6) / 1e6;
    }
    sys.logoFround6 = logoFround6;

    const Trace = (() => {
        const traceKeys = [
            "parse",
            "parse.result",
            "evx",
            "evalJs",
            "codegen",
            "codegen.genLocal",
            "codegen.lambda",
            "console",
            "lrt",
            "time",
            "draw",
            "tmp"
        ];

        const Trace = {};

        const traceTable = {};
        traceKeys.forEach(v => traceTable[v] = () => {});

        Trace.setTraceOptions = function(keysOn) {
            const reKeysOn = makeMatchListRegexp(keysOn);
            traceKeys.filter(v => v.match(reKeysOn))
                .forEach(v => traceTable[v] = console.error); // eslint-disable-line no-console
        };

        Trace.trace = function(text, key) {
            assert(key in traceTable, "Unknown trace key: " + key);
            if (Config.get("trace")) {
                traceTable[key](text);
            }
        };

        Trace.getTraceStream = function(key) {
            return traceTable[key];
        };

        return Trace;
    })();

    sys.trace = Trace.trace;
    sys.Trace = Trace;

    const Config = (() => {
        const Config = {};
        const config = {
            unitTestsJsSrcFile: "../generated/unittests.js",
            demoJsSrcFile: "../generated/demo.js",
            unactionableDatum : true,  // raise runtime exception for unactionable datum
            genCommand : false,        // use codegen for interactive commands
            dynamicScope: true,
            verbose: false,
            postfix: false,
            trace: true
        };

        Config.set = function(configName, val) {
            assert(configName in config, "Unknown config:" + configName);
            assert(typeof val == typeof config[configName], "Expect type:" + typeof config[configName] + " but got type:" + typeof val + " on config:" + configName);
            config[configName] = val;
        };

        Config.get = function(configName) {
            assert(configName in config, "Unknown config:" + configName);
            return config[configName];
        };

        Config.setConfigs = function(configNames, val) {
            configNames.forEach(configName =>
                Config.set(configName, val));
        };

        return Config;
    })();
    sys.Config = Config;

    function toNumberIfApplicable(s) {
        if (typeof s === "object" || s === "\n") {
            return s;
        }

        let t = Number(s);
        return isNaN(t) ? s : t;
    }
    sys.toNumberIfApplicable = toNumberIfApplicable;

    return sys;
};

if (typeof exports != "undefined") {
    exports.$classObj = $classObj;
}
