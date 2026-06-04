"use strict";
(() => {
  // src/ast.ts
  function* walk(node) {
    yield node;
    if (node.type === "document" || node.type === "section" || node.type === "directive") {
      for (const child of node.children) yield* walk(child);
    } else if (node.type === "list") {
      for (const item of node.items) yield* walk(item);
    }
  }

  // node_modules/js-yaml/dist/js-yaml.mjs
  function isNothing(subject) {
    return typeof subject === "undefined" || subject === null;
  }
  function isObject(subject) {
    return typeof subject === "object" && subject !== null;
  }
  function toArray(sequence) {
    if (Array.isArray(sequence)) return sequence;
    else if (isNothing(sequence)) return [];
    return [sequence];
  }
  function extend(target, source) {
    var index, length, key, sourceKeys;
    if (source) {
      sourceKeys = Object.keys(source);
      for (index = 0, length = sourceKeys.length; index < length; index += 1) {
        key = sourceKeys[index];
        target[key] = source[key];
      }
    }
    return target;
  }
  function repeat(string, count) {
    var result = "", cycle;
    for (cycle = 0; cycle < count; cycle += 1) {
      result += string;
    }
    return result;
  }
  function isNegativeZero(number) {
    return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
  }
  var isNothing_1 = isNothing;
  var isObject_1 = isObject;
  var toArray_1 = toArray;
  var repeat_1 = repeat;
  var isNegativeZero_1 = isNegativeZero;
  var extend_1 = extend;
  var common = {
    isNothing: isNothing_1,
    isObject: isObject_1,
    toArray: toArray_1,
    repeat: repeat_1,
    isNegativeZero: isNegativeZero_1,
    extend: extend_1
  };
  function formatError(exception2, compact) {
    var where = "", message = exception2.reason || "(unknown reason)";
    if (!exception2.mark) return message;
    if (exception2.mark.name) {
      where += 'in "' + exception2.mark.name + '" ';
    }
    where += "(" + (exception2.mark.line + 1) + ":" + (exception2.mark.column + 1) + ")";
    if (!compact && exception2.mark.snippet) {
      where += "\n\n" + exception2.mark.snippet;
    }
    return message + " " + where;
  }
  function YAMLException$1(reason, mark) {
    Error.call(this);
    this.name = "YAMLException";
    this.reason = reason;
    this.mark = mark;
    this.message = formatError(this, false);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error().stack || "";
    }
  }
  YAMLException$1.prototype = Object.create(Error.prototype);
  YAMLException$1.prototype.constructor = YAMLException$1;
  YAMLException$1.prototype.toString = function toString(compact) {
    return this.name + ": " + formatError(this, compact);
  };
  var exception = YAMLException$1;
  function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
    var head = "";
    var tail = "";
    var maxHalfLength = Math.floor(maxLineLength / 2) - 1;
    if (position - lineStart > maxHalfLength) {
      head = " ... ";
      lineStart = position - maxHalfLength + head.length;
    }
    if (lineEnd - position > maxHalfLength) {
      tail = " ...";
      lineEnd = position + maxHalfLength - tail.length;
    }
    return {
      str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
      pos: position - lineStart + head.length
      // relative position
    };
  }
  function padStart(string, max) {
    return common.repeat(" ", max - string.length) + string;
  }
  function makeSnippet(mark, options) {
    options = Object.create(options || null);
    if (!mark.buffer) return null;
    if (!options.maxLength) options.maxLength = 79;
    if (typeof options.indent !== "number") options.indent = 1;
    if (typeof options.linesBefore !== "number") options.linesBefore = 3;
    if (typeof options.linesAfter !== "number") options.linesAfter = 2;
    var re = /\r?\n|\r|\0/g;
    var lineStarts = [0];
    var lineEnds = [];
    var match;
    var foundLineNo = -1;
    while (match = re.exec(mark.buffer)) {
      lineEnds.push(match.index);
      lineStarts.push(match.index + match[0].length);
      if (mark.position <= match.index && foundLineNo < 0) {
        foundLineNo = lineStarts.length - 2;
      }
    }
    if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
    var result = "", i, line;
    var lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
    var maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);
    for (i = 1; i <= options.linesBefore; i++) {
      if (foundLineNo - i < 0) break;
      line = getLine(
        mark.buffer,
        lineStarts[foundLineNo - i],
        lineEnds[foundLineNo - i],
        mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]),
        maxLineLength
      );
      result = common.repeat(" ", options.indent) + padStart((mark.line - i + 1).toString(), lineNoLength) + " | " + line.str + "\n" + result;
    }
    line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
    result += common.repeat(" ", options.indent) + padStart((mark.line + 1).toString(), lineNoLength) + " | " + line.str + "\n";
    result += common.repeat("-", options.indent + lineNoLength + 3 + line.pos) + "^\n";
    for (i = 1; i <= options.linesAfter; i++) {
      if (foundLineNo + i >= lineEnds.length) break;
      line = getLine(
        mark.buffer,
        lineStarts[foundLineNo + i],
        lineEnds[foundLineNo + i],
        mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]),
        maxLineLength
      );
      result += common.repeat(" ", options.indent) + padStart((mark.line + i + 1).toString(), lineNoLength) + " | " + line.str + "\n";
    }
    return result.replace(/\n$/, "");
  }
  var snippet = makeSnippet;
  var TYPE_CONSTRUCTOR_OPTIONS = [
    "kind",
    "multi",
    "resolve",
    "construct",
    "instanceOf",
    "predicate",
    "represent",
    "representName",
    "defaultStyle",
    "styleAliases"
  ];
  var YAML_NODE_KINDS = [
    "scalar",
    "sequence",
    "mapping"
  ];
  function compileStyleAliases(map2) {
    var result = {};
    if (map2 !== null) {
      Object.keys(map2).forEach(function(style) {
        map2[style].forEach(function(alias) {
          result[String(alias)] = style;
        });
      });
    }
    return result;
  }
  function Type$1(tag, options) {
    options = options || {};
    Object.keys(options).forEach(function(name) {
      if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
        throw new exception('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
      }
    });
    this.options = options;
    this.tag = tag;
    this.kind = options["kind"] || null;
    this.resolve = options["resolve"] || function() {
      return true;
    };
    this.construct = options["construct"] || function(data) {
      return data;
    };
    this.instanceOf = options["instanceOf"] || null;
    this.predicate = options["predicate"] || null;
    this.represent = options["represent"] || null;
    this.representName = options["representName"] || null;
    this.defaultStyle = options["defaultStyle"] || null;
    this.multi = options["multi"] || false;
    this.styleAliases = compileStyleAliases(options["styleAliases"] || null);
    if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
      throw new exception('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
    }
  }
  var type = Type$1;
  function compileList(schema2, name) {
    var result = [];
    schema2[name].forEach(function(currentType) {
      var newIndex = result.length;
      result.forEach(function(previousType, previousIndex) {
        if (previousType.tag === currentType.tag && previousType.kind === currentType.kind && previousType.multi === currentType.multi) {
          newIndex = previousIndex;
        }
      });
      result[newIndex] = currentType;
    });
    return result;
  }
  function compileMap() {
    var result = {
      scalar: {},
      sequence: {},
      mapping: {},
      fallback: {},
      multi: {
        scalar: [],
        sequence: [],
        mapping: [],
        fallback: []
      }
    }, index, length;
    function collectType(type2) {
      if (type2.multi) {
        result.multi[type2.kind].push(type2);
        result.multi["fallback"].push(type2);
      } else {
        result[type2.kind][type2.tag] = result["fallback"][type2.tag] = type2;
      }
    }
    for (index = 0, length = arguments.length; index < length; index += 1) {
      arguments[index].forEach(collectType);
    }
    return result;
  }
  function Schema$1(definition) {
    return this.extend(definition);
  }
  Schema$1.prototype.extend = function extend2(definition) {
    var implicit = [];
    var explicit = [];
    if (definition instanceof type) {
      explicit.push(definition);
    } else if (Array.isArray(definition)) {
      explicit = explicit.concat(definition);
    } else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
      if (definition.implicit) implicit = implicit.concat(definition.implicit);
      if (definition.explicit) explicit = explicit.concat(definition.explicit);
    } else {
      throw new exception("Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })");
    }
    implicit.forEach(function(type$1) {
      if (!(type$1 instanceof type)) {
        throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
      }
      if (type$1.loadKind && type$1.loadKind !== "scalar") {
        throw new exception("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
      }
      if (type$1.multi) {
        throw new exception("There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.");
      }
    });
    explicit.forEach(function(type$1) {
      if (!(type$1 instanceof type)) {
        throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
      }
    });
    var result = Object.create(Schema$1.prototype);
    result.implicit = (this.implicit || []).concat(implicit);
    result.explicit = (this.explicit || []).concat(explicit);
    result.compiledImplicit = compileList(result, "implicit");
    result.compiledExplicit = compileList(result, "explicit");
    result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);
    return result;
  };
  var schema = Schema$1;
  var str = new type("tag:yaml.org,2002:str", {
    kind: "scalar",
    construct: function(data) {
      return data !== null ? data : "";
    }
  });
  var seq = new type("tag:yaml.org,2002:seq", {
    kind: "sequence",
    construct: function(data) {
      return data !== null ? data : [];
    }
  });
  var map = new type("tag:yaml.org,2002:map", {
    kind: "mapping",
    construct: function(data) {
      return data !== null ? data : {};
    }
  });
  var failsafe = new schema({
    explicit: [
      str,
      seq,
      map
    ]
  });
  function resolveYamlNull(data) {
    if (data === null) return true;
    var max = data.length;
    return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
  }
  function constructYamlNull() {
    return null;
  }
  function isNull(object) {
    return object === null;
  }
  var _null = new type("tag:yaml.org,2002:null", {
    kind: "scalar",
    resolve: resolveYamlNull,
    construct: constructYamlNull,
    predicate: isNull,
    represent: {
      canonical: function() {
        return "~";
      },
      lowercase: function() {
        return "null";
      },
      uppercase: function() {
        return "NULL";
      },
      camelcase: function() {
        return "Null";
      },
      empty: function() {
        return "";
      }
    },
    defaultStyle: "lowercase"
  });
  function resolveYamlBoolean(data) {
    if (data === null) return false;
    var max = data.length;
    return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
  }
  function constructYamlBoolean(data) {
    return data === "true" || data === "True" || data === "TRUE";
  }
  function isBoolean(object) {
    return Object.prototype.toString.call(object) === "[object Boolean]";
  }
  var bool = new type("tag:yaml.org,2002:bool", {
    kind: "scalar",
    resolve: resolveYamlBoolean,
    construct: constructYamlBoolean,
    predicate: isBoolean,
    represent: {
      lowercase: function(object) {
        return object ? "true" : "false";
      },
      uppercase: function(object) {
        return object ? "TRUE" : "FALSE";
      },
      camelcase: function(object) {
        return object ? "True" : "False";
      }
    },
    defaultStyle: "lowercase"
  });
  function isHexCode(c) {
    return 48 <= c && c <= 57 || 65 <= c && c <= 70 || 97 <= c && c <= 102;
  }
  function isOctCode(c) {
    return 48 <= c && c <= 55;
  }
  function isDecCode(c) {
    return 48 <= c && c <= 57;
  }
  function resolveYamlInteger(data) {
    if (data === null) return false;
    var max = data.length, index = 0, hasDigits = false, ch;
    if (!max) return false;
    ch = data[index];
    if (ch === "-" || ch === "+") {
      ch = data[++index];
    }
    if (ch === "0") {
      if (index + 1 === max) return true;
      ch = data[++index];
      if (ch === "b") {
        index++;
        for (; index < max; index++) {
          ch = data[index];
          if (ch === "_") continue;
          if (ch !== "0" && ch !== "1") return false;
          hasDigits = true;
        }
        return hasDigits && ch !== "_";
      }
      if (ch === "x") {
        index++;
        for (; index < max; index++) {
          ch = data[index];
          if (ch === "_") continue;
          if (!isHexCode(data.charCodeAt(index))) return false;
          hasDigits = true;
        }
        return hasDigits && ch !== "_";
      }
      if (ch === "o") {
        index++;
        for (; index < max; index++) {
          ch = data[index];
          if (ch === "_") continue;
          if (!isOctCode(data.charCodeAt(index))) return false;
          hasDigits = true;
        }
        return hasDigits && ch !== "_";
      }
    }
    if (ch === "_") return false;
    for (; index < max; index++) {
      ch = data[index];
      if (ch === "_") continue;
      if (!isDecCode(data.charCodeAt(index))) {
        return false;
      }
      hasDigits = true;
    }
    if (!hasDigits || ch === "_") return false;
    return true;
  }
  function constructYamlInteger(data) {
    var value = data, sign = 1, ch;
    if (value.indexOf("_") !== -1) {
      value = value.replace(/_/g, "");
    }
    ch = value[0];
    if (ch === "-" || ch === "+") {
      if (ch === "-") sign = -1;
      value = value.slice(1);
      ch = value[0];
    }
    if (value === "0") return 0;
    if (ch === "0") {
      if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
      if (value[1] === "x") return sign * parseInt(value.slice(2), 16);
      if (value[1] === "o") return sign * parseInt(value.slice(2), 8);
    }
    return sign * parseInt(value, 10);
  }
  function isInteger(object) {
    return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 === 0 && !common.isNegativeZero(object));
  }
  var int = new type("tag:yaml.org,2002:int", {
    kind: "scalar",
    resolve: resolveYamlInteger,
    construct: constructYamlInteger,
    predicate: isInteger,
    represent: {
      binary: function(obj) {
        return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
      },
      octal: function(obj) {
        return obj >= 0 ? "0o" + obj.toString(8) : "-0o" + obj.toString(8).slice(1);
      },
      decimal: function(obj) {
        return obj.toString(10);
      },
      /* eslint-disable max-len */
      hexadecimal: function(obj) {
        return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
      }
    },
    defaultStyle: "decimal",
    styleAliases: {
      binary: [2, "bin"],
      octal: [8, "oct"],
      decimal: [10, "dec"],
      hexadecimal: [16, "hex"]
    }
  });
  var YAML_FLOAT_PATTERN = new RegExp(
    // 2.5e4, 2.5 and integers
    "^(?:[-+]?(?:[0-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
  );
  function resolveYamlFloat(data) {
    if (data === null) return false;
    if (!YAML_FLOAT_PATTERN.test(data) || // Quick hack to not allow integers end with `_`
    // Probably should update regexp & check speed
    data[data.length - 1] === "_") {
      return false;
    }
    return true;
  }
  function constructYamlFloat(data) {
    var value, sign;
    value = data.replace(/_/g, "").toLowerCase();
    sign = value[0] === "-" ? -1 : 1;
    if ("+-".indexOf(value[0]) >= 0) {
      value = value.slice(1);
    }
    if (value === ".inf") {
      return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    } else if (value === ".nan") {
      return NaN;
    }
    return sign * parseFloat(value, 10);
  }
  var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
  function representYamlFloat(object, style) {
    var res;
    if (isNaN(object)) {
      switch (style) {
        case "lowercase":
          return ".nan";
        case "uppercase":
          return ".NAN";
        case "camelcase":
          return ".NaN";
      }
    } else if (Number.POSITIVE_INFINITY === object) {
      switch (style) {
        case "lowercase":
          return ".inf";
        case "uppercase":
          return ".INF";
        case "camelcase":
          return ".Inf";
      }
    } else if (Number.NEGATIVE_INFINITY === object) {
      switch (style) {
        case "lowercase":
          return "-.inf";
        case "uppercase":
          return "-.INF";
        case "camelcase":
          return "-.Inf";
      }
    } else if (common.isNegativeZero(object)) {
      return "-0.0";
    }
    res = object.toString(10);
    return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
  }
  function isFloat(object) {
    return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common.isNegativeZero(object));
  }
  var float = new type("tag:yaml.org,2002:float", {
    kind: "scalar",
    resolve: resolveYamlFloat,
    construct: constructYamlFloat,
    predicate: isFloat,
    represent: representYamlFloat,
    defaultStyle: "lowercase"
  });
  var json = failsafe.extend({
    implicit: [
      _null,
      bool,
      int,
      float
    ]
  });
  var core = json;
  var YAML_DATE_REGEXP = new RegExp(
    "^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"
  );
  var YAML_TIMESTAMP_REGEXP = new RegExp(
    "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
  );
  function resolveYamlTimestamp(data) {
    if (data === null) return false;
    if (YAML_DATE_REGEXP.exec(data) !== null) return true;
    if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
    return false;
  }
  function constructYamlTimestamp(data) {
    var match, year, month, day, hour, minute, second, fraction = 0, delta = null, tz_hour, tz_minute, date;
    match = YAML_DATE_REGEXP.exec(data);
    if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
    if (match === null) throw new Error("Date resolve error");
    year = +match[1];
    month = +match[2] - 1;
    day = +match[3];
    if (!match[4]) {
      return new Date(Date.UTC(year, month, day));
    }
    hour = +match[4];
    minute = +match[5];
    second = +match[6];
    if (match[7]) {
      fraction = match[7].slice(0, 3);
      while (fraction.length < 3) {
        fraction += "0";
      }
      fraction = +fraction;
    }
    if (match[9]) {
      tz_hour = +match[10];
      tz_minute = +(match[11] || 0);
      delta = (tz_hour * 60 + tz_minute) * 6e4;
      if (match[9] === "-") delta = -delta;
    }
    date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
    if (delta) date.setTime(date.getTime() - delta);
    return date;
  }
  function representYamlTimestamp(object) {
    return object.toISOString();
  }
  var timestamp = new type("tag:yaml.org,2002:timestamp", {
    kind: "scalar",
    resolve: resolveYamlTimestamp,
    construct: constructYamlTimestamp,
    instanceOf: Date,
    represent: representYamlTimestamp
  });
  function resolveYamlMerge(data) {
    return data === "<<" || data === null;
  }
  var merge = new type("tag:yaml.org,2002:merge", {
    kind: "scalar",
    resolve: resolveYamlMerge
  });
  var BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
  function resolveYamlBinary(data) {
    if (data === null) return false;
    var code, idx, bitlen = 0, max = data.length, map2 = BASE64_MAP;
    for (idx = 0; idx < max; idx++) {
      code = map2.indexOf(data.charAt(idx));
      if (code > 64) continue;
      if (code < 0) return false;
      bitlen += 6;
    }
    return bitlen % 8 === 0;
  }
  function constructYamlBinary(data) {
    var idx, tailbits, input = data.replace(/[\r\n=]/g, ""), max = input.length, map2 = BASE64_MAP, bits = 0, result = [];
    for (idx = 0; idx < max; idx++) {
      if (idx % 4 === 0 && idx) {
        result.push(bits >> 16 & 255);
        result.push(bits >> 8 & 255);
        result.push(bits & 255);
      }
      bits = bits << 6 | map2.indexOf(input.charAt(idx));
    }
    tailbits = max % 4 * 6;
    if (tailbits === 0) {
      result.push(bits >> 16 & 255);
      result.push(bits >> 8 & 255);
      result.push(bits & 255);
    } else if (tailbits === 18) {
      result.push(bits >> 10 & 255);
      result.push(bits >> 2 & 255);
    } else if (tailbits === 12) {
      result.push(bits >> 4 & 255);
    }
    return new Uint8Array(result);
  }
  function representYamlBinary(object) {
    var result = "", bits = 0, idx, tail, max = object.length, map2 = BASE64_MAP;
    for (idx = 0; idx < max; idx++) {
      if (idx % 3 === 0 && idx) {
        result += map2[bits >> 18 & 63];
        result += map2[bits >> 12 & 63];
        result += map2[bits >> 6 & 63];
        result += map2[bits & 63];
      }
      bits = (bits << 8) + object[idx];
    }
    tail = max % 3;
    if (tail === 0) {
      result += map2[bits >> 18 & 63];
      result += map2[bits >> 12 & 63];
      result += map2[bits >> 6 & 63];
      result += map2[bits & 63];
    } else if (tail === 2) {
      result += map2[bits >> 10 & 63];
      result += map2[bits >> 4 & 63];
      result += map2[bits << 2 & 63];
      result += map2[64];
    } else if (tail === 1) {
      result += map2[bits >> 2 & 63];
      result += map2[bits << 4 & 63];
      result += map2[64];
      result += map2[64];
    }
    return result;
  }
  function isBinary(obj) {
    return Object.prototype.toString.call(obj) === "[object Uint8Array]";
  }
  var binary = new type("tag:yaml.org,2002:binary", {
    kind: "scalar",
    resolve: resolveYamlBinary,
    construct: constructYamlBinary,
    predicate: isBinary,
    represent: representYamlBinary
  });
  var _hasOwnProperty$3 = Object.prototype.hasOwnProperty;
  var _toString$2 = Object.prototype.toString;
  function resolveYamlOmap(data) {
    if (data === null) return true;
    var objectKeys = [], index, length, pair, pairKey, pairHasKey, object = data;
    for (index = 0, length = object.length; index < length; index += 1) {
      pair = object[index];
      pairHasKey = false;
      if (_toString$2.call(pair) !== "[object Object]") return false;
      for (pairKey in pair) {
        if (_hasOwnProperty$3.call(pair, pairKey)) {
          if (!pairHasKey) pairHasKey = true;
          else return false;
        }
      }
      if (!pairHasKey) return false;
      if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
      else return false;
    }
    return true;
  }
  function constructYamlOmap(data) {
    return data !== null ? data : [];
  }
  var omap = new type("tag:yaml.org,2002:omap", {
    kind: "sequence",
    resolve: resolveYamlOmap,
    construct: constructYamlOmap
  });
  var _toString$1 = Object.prototype.toString;
  function resolveYamlPairs(data) {
    if (data === null) return true;
    var index, length, pair, keys, result, object = data;
    result = new Array(object.length);
    for (index = 0, length = object.length; index < length; index += 1) {
      pair = object[index];
      if (_toString$1.call(pair) !== "[object Object]") return false;
      keys = Object.keys(pair);
      if (keys.length !== 1) return false;
      result[index] = [keys[0], pair[keys[0]]];
    }
    return true;
  }
  function constructYamlPairs(data) {
    if (data === null) return [];
    var index, length, pair, keys, result, object = data;
    result = new Array(object.length);
    for (index = 0, length = object.length; index < length; index += 1) {
      pair = object[index];
      keys = Object.keys(pair);
      result[index] = [keys[0], pair[keys[0]]];
    }
    return result;
  }
  var pairs = new type("tag:yaml.org,2002:pairs", {
    kind: "sequence",
    resolve: resolveYamlPairs,
    construct: constructYamlPairs
  });
  var _hasOwnProperty$2 = Object.prototype.hasOwnProperty;
  function resolveYamlSet(data) {
    if (data === null) return true;
    var key, object = data;
    for (key in object) {
      if (_hasOwnProperty$2.call(object, key)) {
        if (object[key] !== null) return false;
      }
    }
    return true;
  }
  function constructYamlSet(data) {
    return data !== null ? data : {};
  }
  var set = new type("tag:yaml.org,2002:set", {
    kind: "mapping",
    resolve: resolveYamlSet,
    construct: constructYamlSet
  });
  var _default = core.extend({
    implicit: [
      timestamp,
      merge
    ],
    explicit: [
      binary,
      omap,
      pairs,
      set
    ]
  });
  var _hasOwnProperty$1 = Object.prototype.hasOwnProperty;
  var CONTEXT_FLOW_IN = 1;
  var CONTEXT_FLOW_OUT = 2;
  var CONTEXT_BLOCK_IN = 3;
  var CONTEXT_BLOCK_OUT = 4;
  var CHOMPING_CLIP = 1;
  var CHOMPING_STRIP = 2;
  var CHOMPING_KEEP = 3;
  var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
  var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
  var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
  var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
  var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
  function _class(obj) {
    return Object.prototype.toString.call(obj);
  }
  function is_EOL(c) {
    return c === 10 || c === 13;
  }
  function is_WHITE_SPACE(c) {
    return c === 9 || c === 32;
  }
  function is_WS_OR_EOL(c) {
    return c === 9 || c === 32 || c === 10 || c === 13;
  }
  function is_FLOW_INDICATOR(c) {
    return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
  }
  function fromHexCode(c) {
    var lc;
    if (48 <= c && c <= 57) {
      return c - 48;
    }
    lc = c | 32;
    if (97 <= lc && lc <= 102) {
      return lc - 97 + 10;
    }
    return -1;
  }
  function escapedHexLen(c) {
    if (c === 120) {
      return 2;
    }
    if (c === 117) {
      return 4;
    }
    if (c === 85) {
      return 8;
    }
    return 0;
  }
  function fromDecimalCode(c) {
    if (48 <= c && c <= 57) {
      return c - 48;
    }
    return -1;
  }
  function simpleEscapeSequence(c) {
    return c === 48 ? "\0" : c === 97 ? "\x07" : c === 98 ? "\b" : c === 116 ? "	" : c === 9 ? "	" : c === 110 ? "\n" : c === 118 ? "\v" : c === 102 ? "\f" : c === 114 ? "\r" : c === 101 ? "\x1B" : c === 32 ? " " : c === 34 ? '"' : c === 47 ? "/" : c === 92 ? "\\" : c === 78 ? "\x85" : c === 95 ? "\xA0" : c === 76 ? "\u2028" : c === 80 ? "\u2029" : "";
  }
  function charFromCodepoint(c) {
    if (c <= 65535) {
      return String.fromCharCode(c);
    }
    return String.fromCharCode(
      (c - 65536 >> 10) + 55296,
      (c - 65536 & 1023) + 56320
    );
  }
  function setProperty(object, key, value) {
    if (key === "__proto__") {
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      });
    } else {
      object[key] = value;
    }
  }
  var simpleEscapeCheck = new Array(256);
  var simpleEscapeMap = new Array(256);
  for (i = 0; i < 256; i++) {
    simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
    simpleEscapeMap[i] = simpleEscapeSequence(i);
  }
  var i;
  function State$1(input, options) {
    this.input = input;
    this.filename = options["filename"] || null;
    this.schema = options["schema"] || _default;
    this.onWarning = options["onWarning"] || null;
    this.legacy = options["legacy"] || false;
    this.json = options["json"] || false;
    this.listener = options["listener"] || null;
    this.implicitTypes = this.schema.compiledImplicit;
    this.typeMap = this.schema.compiledTypeMap;
    this.length = input.length;
    this.position = 0;
    this.line = 0;
    this.lineStart = 0;
    this.lineIndent = 0;
    this.firstTabInLine = -1;
    this.documents = [];
  }
  function generateError(state2, message) {
    var mark = {
      name: state2.filename,
      buffer: state2.input.slice(0, -1),
      // omit trailing \0
      position: state2.position,
      line: state2.line,
      column: state2.position - state2.lineStart
    };
    mark.snippet = snippet(mark);
    return new exception(message, mark);
  }
  function throwError(state2, message) {
    throw generateError(state2, message);
  }
  function throwWarning(state2, message) {
    if (state2.onWarning) {
      state2.onWarning.call(null, generateError(state2, message));
    }
  }
  var directiveHandlers = {
    YAML: function handleYamlDirective(state2, name, args) {
      var match, major, minor;
      if (state2.version !== null) {
        throwError(state2, "duplication of %YAML directive");
      }
      if (args.length !== 1) {
        throwError(state2, "YAML directive accepts exactly one argument");
      }
      match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
      if (match === null) {
        throwError(state2, "ill-formed argument of the YAML directive");
      }
      major = parseInt(match[1], 10);
      minor = parseInt(match[2], 10);
      if (major !== 1) {
        throwError(state2, "unacceptable YAML version of the document");
      }
      state2.version = args[0];
      state2.checkLineBreaks = minor < 2;
      if (minor !== 1 && minor !== 2) {
        throwWarning(state2, "unsupported YAML version of the document");
      }
    },
    TAG: function handleTagDirective(state2, name, args) {
      var handle, prefix;
      if (args.length !== 2) {
        throwError(state2, "TAG directive accepts exactly two arguments");
      }
      handle = args[0];
      prefix = args[1];
      if (!PATTERN_TAG_HANDLE.test(handle)) {
        throwError(state2, "ill-formed tag handle (first argument) of the TAG directive");
      }
      if (_hasOwnProperty$1.call(state2.tagMap, handle)) {
        throwError(state2, 'there is a previously declared suffix for "' + handle + '" tag handle');
      }
      if (!PATTERN_TAG_URI.test(prefix)) {
        throwError(state2, "ill-formed tag prefix (second argument) of the TAG directive");
      }
      try {
        prefix = decodeURIComponent(prefix);
      } catch (err) {
        throwError(state2, "tag prefix is malformed: " + prefix);
      }
      state2.tagMap[handle] = prefix;
    }
  };
  function captureSegment(state2, start, end, checkJson) {
    var _position, _length, _character, _result;
    if (start < end) {
      _result = state2.input.slice(start, end);
      if (checkJson) {
        for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
          _character = _result.charCodeAt(_position);
          if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
            throwError(state2, "expected valid JSON character");
          }
        }
      } else if (PATTERN_NON_PRINTABLE.test(_result)) {
        throwError(state2, "the stream contains non-printable characters");
      }
      state2.result += _result;
    }
  }
  function mergeMappings(state2, destination, source, overridableKeys) {
    var sourceKeys, key, index, quantity;
    if (!common.isObject(source)) {
      throwError(state2, "cannot merge mappings; the provided source object is unacceptable");
    }
    sourceKeys = Object.keys(source);
    for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
      key = sourceKeys[index];
      if (!_hasOwnProperty$1.call(destination, key)) {
        setProperty(destination, key, source[key]);
        overridableKeys[key] = true;
      }
    }
  }
  function storeMappingPair(state2, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startLineStart, startPos) {
    var index, quantity;
    if (Array.isArray(keyNode)) {
      keyNode = Array.prototype.slice.call(keyNode);
      for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
        if (Array.isArray(keyNode[index])) {
          throwError(state2, "nested arrays are not supported inside keys");
        }
        if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") {
          keyNode[index] = "[object Object]";
        }
      }
    }
    if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") {
      keyNode = "[object Object]";
    }
    keyNode = String(keyNode);
    if (_result === null) {
      _result = {};
    }
    if (keyTag === "tag:yaml.org,2002:merge") {
      if (Array.isArray(valueNode)) {
        for (index = 0, quantity = valueNode.length; index < quantity; index += 1) {
          mergeMappings(state2, _result, valueNode[index], overridableKeys);
        }
      } else {
        mergeMappings(state2, _result, valueNode, overridableKeys);
      }
    } else {
      if (!state2.json && !_hasOwnProperty$1.call(overridableKeys, keyNode) && _hasOwnProperty$1.call(_result, keyNode)) {
        state2.line = startLine || state2.line;
        state2.lineStart = startLineStart || state2.lineStart;
        state2.position = startPos || state2.position;
        throwError(state2, "duplicated mapping key");
      }
      setProperty(_result, keyNode, valueNode);
      delete overridableKeys[keyNode];
    }
    return _result;
  }
  function readLineBreak(state2) {
    var ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch === 10) {
      state2.position++;
    } else if (ch === 13) {
      state2.position++;
      if (state2.input.charCodeAt(state2.position) === 10) {
        state2.position++;
      }
    } else {
      throwError(state2, "a line break is expected");
    }
    state2.line += 1;
    state2.lineStart = state2.position;
    state2.firstTabInLine = -1;
  }
  function skipSeparationSpace(state2, allowComments, checkIndent) {
    var lineBreaks = 0, ch = state2.input.charCodeAt(state2.position);
    while (ch !== 0) {
      while (is_WHITE_SPACE(ch)) {
        if (ch === 9 && state2.firstTabInLine === -1) {
          state2.firstTabInLine = state2.position;
        }
        ch = state2.input.charCodeAt(++state2.position);
      }
      if (allowComments && ch === 35) {
        do {
          ch = state2.input.charCodeAt(++state2.position);
        } while (ch !== 10 && ch !== 13 && ch !== 0);
      }
      if (is_EOL(ch)) {
        readLineBreak(state2);
        ch = state2.input.charCodeAt(state2.position);
        lineBreaks++;
        state2.lineIndent = 0;
        while (ch === 32) {
          state2.lineIndent++;
          ch = state2.input.charCodeAt(++state2.position);
        }
      } else {
        break;
      }
    }
    if (checkIndent !== -1 && lineBreaks !== 0 && state2.lineIndent < checkIndent) {
      throwWarning(state2, "deficient indentation");
    }
    return lineBreaks;
  }
  function testDocumentSeparator(state2) {
    var _position = state2.position, ch;
    ch = state2.input.charCodeAt(_position);
    if ((ch === 45 || ch === 46) && ch === state2.input.charCodeAt(_position + 1) && ch === state2.input.charCodeAt(_position + 2)) {
      _position += 3;
      ch = state2.input.charCodeAt(_position);
      if (ch === 0 || is_WS_OR_EOL(ch)) {
        return true;
      }
    }
    return false;
  }
  function writeFoldedLines(state2, count) {
    if (count === 1) {
      state2.result += " ";
    } else if (count > 1) {
      state2.result += common.repeat("\n", count - 1);
    }
  }
  function readPlainScalar(state2, nodeIndent, withinFlowCollection) {
    var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state2.kind, _result = state2.result, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
      return false;
    }
    if (ch === 63 || ch === 45) {
      following = state2.input.charCodeAt(state2.position + 1);
      if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
        return false;
      }
    }
    state2.kind = "scalar";
    state2.result = "";
    captureStart = captureEnd = state2.position;
    hasPendingContent = false;
    while (ch !== 0) {
      if (ch === 58) {
        following = state2.input.charCodeAt(state2.position + 1);
        if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
          break;
        }
      } else if (ch === 35) {
        preceding = state2.input.charCodeAt(state2.position - 1);
        if (is_WS_OR_EOL(preceding)) {
          break;
        }
      } else if (state2.position === state2.lineStart && testDocumentSeparator(state2) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
        break;
      } else if (is_EOL(ch)) {
        _line = state2.line;
        _lineStart = state2.lineStart;
        _lineIndent = state2.lineIndent;
        skipSeparationSpace(state2, false, -1);
        if (state2.lineIndent >= nodeIndent) {
          hasPendingContent = true;
          ch = state2.input.charCodeAt(state2.position);
          continue;
        } else {
          state2.position = captureEnd;
          state2.line = _line;
          state2.lineStart = _lineStart;
          state2.lineIndent = _lineIndent;
          break;
        }
      }
      if (hasPendingContent) {
        captureSegment(state2, captureStart, captureEnd, false);
        writeFoldedLines(state2, state2.line - _line);
        captureStart = captureEnd = state2.position;
        hasPendingContent = false;
      }
      if (!is_WHITE_SPACE(ch)) {
        captureEnd = state2.position + 1;
      }
      ch = state2.input.charCodeAt(++state2.position);
    }
    captureSegment(state2, captureStart, captureEnd, false);
    if (state2.result) {
      return true;
    }
    state2.kind = _kind;
    state2.result = _result;
    return false;
  }
  function readSingleQuotedScalar(state2, nodeIndent) {
    var ch, captureStart, captureEnd;
    ch = state2.input.charCodeAt(state2.position);
    if (ch !== 39) {
      return false;
    }
    state2.kind = "scalar";
    state2.result = "";
    state2.position++;
    captureStart = captureEnd = state2.position;
    while ((ch = state2.input.charCodeAt(state2.position)) !== 0) {
      if (ch === 39) {
        captureSegment(state2, captureStart, state2.position, true);
        ch = state2.input.charCodeAt(++state2.position);
        if (ch === 39) {
          captureStart = state2.position;
          state2.position++;
          captureEnd = state2.position;
        } else {
          return true;
        }
      } else if (is_EOL(ch)) {
        captureSegment(state2, captureStart, captureEnd, true);
        writeFoldedLines(state2, skipSeparationSpace(state2, false, nodeIndent));
        captureStart = captureEnd = state2.position;
      } else if (state2.position === state2.lineStart && testDocumentSeparator(state2)) {
        throwError(state2, "unexpected end of the document within a single quoted scalar");
      } else {
        state2.position++;
        captureEnd = state2.position;
      }
    }
    throwError(state2, "unexpected end of the stream within a single quoted scalar");
  }
  function readDoubleQuotedScalar(state2, nodeIndent) {
    var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch !== 34) {
      return false;
    }
    state2.kind = "scalar";
    state2.result = "";
    state2.position++;
    captureStart = captureEnd = state2.position;
    while ((ch = state2.input.charCodeAt(state2.position)) !== 0) {
      if (ch === 34) {
        captureSegment(state2, captureStart, state2.position, true);
        state2.position++;
        return true;
      } else if (ch === 92) {
        captureSegment(state2, captureStart, state2.position, true);
        ch = state2.input.charCodeAt(++state2.position);
        if (is_EOL(ch)) {
          skipSeparationSpace(state2, false, nodeIndent);
        } else if (ch < 256 && simpleEscapeCheck[ch]) {
          state2.result += simpleEscapeMap[ch];
          state2.position++;
        } else if ((tmp = escapedHexLen(ch)) > 0) {
          hexLength = tmp;
          hexResult = 0;
          for (; hexLength > 0; hexLength--) {
            ch = state2.input.charCodeAt(++state2.position);
            if ((tmp = fromHexCode(ch)) >= 0) {
              hexResult = (hexResult << 4) + tmp;
            } else {
              throwError(state2, "expected hexadecimal character");
            }
          }
          state2.result += charFromCodepoint(hexResult);
          state2.position++;
        } else {
          throwError(state2, "unknown escape sequence");
        }
        captureStart = captureEnd = state2.position;
      } else if (is_EOL(ch)) {
        captureSegment(state2, captureStart, captureEnd, true);
        writeFoldedLines(state2, skipSeparationSpace(state2, false, nodeIndent));
        captureStart = captureEnd = state2.position;
      } else if (state2.position === state2.lineStart && testDocumentSeparator(state2)) {
        throwError(state2, "unexpected end of the document within a double quoted scalar");
      } else {
        state2.position++;
        captureEnd = state2.position;
      }
    }
    throwError(state2, "unexpected end of the stream within a double quoted scalar");
  }
  function readFlowCollection(state2, nodeIndent) {
    var readNext = true, _line, _lineStart, _pos, _tag = state2.tag, _result, _anchor = state2.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = /* @__PURE__ */ Object.create(null), keyNode, keyTag, valueNode, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch === 91) {
      terminator = 93;
      isMapping = false;
      _result = [];
    } else if (ch === 123) {
      terminator = 125;
      isMapping = true;
      _result = {};
    } else {
      return false;
    }
    if (state2.anchor !== null) {
      state2.anchorMap[state2.anchor] = _result;
    }
    ch = state2.input.charCodeAt(++state2.position);
    while (ch !== 0) {
      skipSeparationSpace(state2, true, nodeIndent);
      ch = state2.input.charCodeAt(state2.position);
      if (ch === terminator) {
        state2.position++;
        state2.tag = _tag;
        state2.anchor = _anchor;
        state2.kind = isMapping ? "mapping" : "sequence";
        state2.result = _result;
        return true;
      } else if (!readNext) {
        throwError(state2, "missed comma between flow collection entries");
      } else if (ch === 44) {
        throwError(state2, "expected the node content, but found ','");
      }
      keyTag = keyNode = valueNode = null;
      isPair = isExplicitPair = false;
      if (ch === 63) {
        following = state2.input.charCodeAt(state2.position + 1);
        if (is_WS_OR_EOL(following)) {
          isPair = isExplicitPair = true;
          state2.position++;
          skipSeparationSpace(state2, true, nodeIndent);
        }
      }
      _line = state2.line;
      _lineStart = state2.lineStart;
      _pos = state2.position;
      composeNode(state2, nodeIndent, CONTEXT_FLOW_IN, false, true);
      keyTag = state2.tag;
      keyNode = state2.result;
      skipSeparationSpace(state2, true, nodeIndent);
      ch = state2.input.charCodeAt(state2.position);
      if ((isExplicitPair || state2.line === _line) && ch === 58) {
        isPair = true;
        ch = state2.input.charCodeAt(++state2.position);
        skipSeparationSpace(state2, true, nodeIndent);
        composeNode(state2, nodeIndent, CONTEXT_FLOW_IN, false, true);
        valueNode = state2.result;
      }
      if (isMapping) {
        storeMappingPair(state2, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
      } else if (isPair) {
        _result.push(storeMappingPair(state2, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
      } else {
        _result.push(keyNode);
      }
      skipSeparationSpace(state2, true, nodeIndent);
      ch = state2.input.charCodeAt(state2.position);
      if (ch === 44) {
        readNext = true;
        ch = state2.input.charCodeAt(++state2.position);
      } else {
        readNext = false;
      }
    }
    throwError(state2, "unexpected end of the stream within a flow collection");
  }
  function readBlockScalar(state2, nodeIndent) {
    var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch === 124) {
      folding = false;
    } else if (ch === 62) {
      folding = true;
    } else {
      return false;
    }
    state2.kind = "scalar";
    state2.result = "";
    while (ch !== 0) {
      ch = state2.input.charCodeAt(++state2.position);
      if (ch === 43 || ch === 45) {
        if (CHOMPING_CLIP === chomping) {
          chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
        } else {
          throwError(state2, "repeat of a chomping mode identifier");
        }
      } else if ((tmp = fromDecimalCode(ch)) >= 0) {
        if (tmp === 0) {
          throwError(state2, "bad explicit indentation width of a block scalar; it cannot be less than one");
        } else if (!detectedIndent) {
          textIndent = nodeIndent + tmp - 1;
          detectedIndent = true;
        } else {
          throwError(state2, "repeat of an indentation width identifier");
        }
      } else {
        break;
      }
    }
    if (is_WHITE_SPACE(ch)) {
      do {
        ch = state2.input.charCodeAt(++state2.position);
      } while (is_WHITE_SPACE(ch));
      if (ch === 35) {
        do {
          ch = state2.input.charCodeAt(++state2.position);
        } while (!is_EOL(ch) && ch !== 0);
      }
    }
    while (ch !== 0) {
      readLineBreak(state2);
      state2.lineIndent = 0;
      ch = state2.input.charCodeAt(state2.position);
      while ((!detectedIndent || state2.lineIndent < textIndent) && ch === 32) {
        state2.lineIndent++;
        ch = state2.input.charCodeAt(++state2.position);
      }
      if (!detectedIndent && state2.lineIndent > textIndent) {
        textIndent = state2.lineIndent;
      }
      if (is_EOL(ch)) {
        emptyLines++;
        continue;
      }
      if (state2.lineIndent < textIndent) {
        if (chomping === CHOMPING_KEEP) {
          state2.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
        } else if (chomping === CHOMPING_CLIP) {
          if (didReadContent) {
            state2.result += "\n";
          }
        }
        break;
      }
      if (folding) {
        if (is_WHITE_SPACE(ch)) {
          atMoreIndented = true;
          state2.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
        } else if (atMoreIndented) {
          atMoreIndented = false;
          state2.result += common.repeat("\n", emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didReadContent) {
            state2.result += " ";
          }
        } else {
          state2.result += common.repeat("\n", emptyLines);
        }
      } else {
        state2.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      }
      didReadContent = true;
      detectedIndent = true;
      emptyLines = 0;
      captureStart = state2.position;
      while (!is_EOL(ch) && ch !== 0) {
        ch = state2.input.charCodeAt(++state2.position);
      }
      captureSegment(state2, captureStart, state2.position, false);
    }
    return true;
  }
  function readBlockSequence(state2, nodeIndent) {
    var _line, _tag = state2.tag, _anchor = state2.anchor, _result = [], following, detected = false, ch;
    if (state2.firstTabInLine !== -1) return false;
    if (state2.anchor !== null) {
      state2.anchorMap[state2.anchor] = _result;
    }
    ch = state2.input.charCodeAt(state2.position);
    while (ch !== 0) {
      if (state2.firstTabInLine !== -1) {
        state2.position = state2.firstTabInLine;
        throwError(state2, "tab characters must not be used in indentation");
      }
      if (ch !== 45) {
        break;
      }
      following = state2.input.charCodeAt(state2.position + 1);
      if (!is_WS_OR_EOL(following)) {
        break;
      }
      detected = true;
      state2.position++;
      if (skipSeparationSpace(state2, true, -1)) {
        if (state2.lineIndent <= nodeIndent) {
          _result.push(null);
          ch = state2.input.charCodeAt(state2.position);
          continue;
        }
      }
      _line = state2.line;
      composeNode(state2, nodeIndent, CONTEXT_BLOCK_IN, false, true);
      _result.push(state2.result);
      skipSeparationSpace(state2, true, -1);
      ch = state2.input.charCodeAt(state2.position);
      if ((state2.line === _line || state2.lineIndent > nodeIndent) && ch !== 0) {
        throwError(state2, "bad indentation of a sequence entry");
      } else if (state2.lineIndent < nodeIndent) {
        break;
      }
    }
    if (detected) {
      state2.tag = _tag;
      state2.anchor = _anchor;
      state2.kind = "sequence";
      state2.result = _result;
      return true;
    }
    return false;
  }
  function readBlockMapping(state2, nodeIndent, flowIndent) {
    var following, allowCompact, _line, _keyLine, _keyLineStart, _keyPos, _tag = state2.tag, _anchor = state2.anchor, _result = {}, overridableKeys = /* @__PURE__ */ Object.create(null), keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
    if (state2.firstTabInLine !== -1) return false;
    if (state2.anchor !== null) {
      state2.anchorMap[state2.anchor] = _result;
    }
    ch = state2.input.charCodeAt(state2.position);
    while (ch !== 0) {
      if (!atExplicitKey && state2.firstTabInLine !== -1) {
        state2.position = state2.firstTabInLine;
        throwError(state2, "tab characters must not be used in indentation");
      }
      following = state2.input.charCodeAt(state2.position + 1);
      _line = state2.line;
      if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
        if (ch === 63) {
          if (atExplicitKey) {
            storeMappingPair(state2, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }
          detected = true;
          atExplicitKey = true;
          allowCompact = true;
        } else if (atExplicitKey) {
          atExplicitKey = false;
          allowCompact = true;
        } else {
          throwError(state2, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
        }
        state2.position += 1;
        ch = following;
      } else {
        _keyLine = state2.line;
        _keyLineStart = state2.lineStart;
        _keyPos = state2.position;
        if (!composeNode(state2, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
          break;
        }
        if (state2.line === _line) {
          ch = state2.input.charCodeAt(state2.position);
          while (is_WHITE_SPACE(ch)) {
            ch = state2.input.charCodeAt(++state2.position);
          }
          if (ch === 58) {
            ch = state2.input.charCodeAt(++state2.position);
            if (!is_WS_OR_EOL(ch)) {
              throwError(state2, "a whitespace character is expected after the key-value separator within a block mapping");
            }
            if (atExplicitKey) {
              storeMappingPair(state2, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
              keyTag = keyNode = valueNode = null;
            }
            detected = true;
            atExplicitKey = false;
            allowCompact = false;
            keyTag = state2.tag;
            keyNode = state2.result;
          } else if (detected) {
            throwError(state2, "can not read an implicit mapping pair; a colon is missed");
          } else {
            state2.tag = _tag;
            state2.anchor = _anchor;
            return true;
          }
        } else if (detected) {
          throwError(state2, "can not read a block mapping entry; a multiline key may not be an implicit key");
        } else {
          state2.tag = _tag;
          state2.anchor = _anchor;
          return true;
        }
      }
      if (state2.line === _line || state2.lineIndent > nodeIndent) {
        if (atExplicitKey) {
          _keyLine = state2.line;
          _keyLineStart = state2.lineStart;
          _keyPos = state2.position;
        }
        if (composeNode(state2, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
          if (atExplicitKey) {
            keyNode = state2.result;
          } else {
            valueNode = state2.result;
          }
        }
        if (!atExplicitKey) {
          storeMappingPair(state2, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }
        skipSeparationSpace(state2, true, -1);
        ch = state2.input.charCodeAt(state2.position);
      }
      if ((state2.line === _line || state2.lineIndent > nodeIndent) && ch !== 0) {
        throwError(state2, "bad indentation of a mapping entry");
      } else if (state2.lineIndent < nodeIndent) {
        break;
      }
    }
    if (atExplicitKey) {
      storeMappingPair(state2, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
    }
    if (detected) {
      state2.tag = _tag;
      state2.anchor = _anchor;
      state2.kind = "mapping";
      state2.result = _result;
    }
    return detected;
  }
  function readTagProperty(state2) {
    var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch !== 33) return false;
    if (state2.tag !== null) {
      throwError(state2, "duplication of a tag property");
    }
    ch = state2.input.charCodeAt(++state2.position);
    if (ch === 60) {
      isVerbatim = true;
      ch = state2.input.charCodeAt(++state2.position);
    } else if (ch === 33) {
      isNamed = true;
      tagHandle = "!!";
      ch = state2.input.charCodeAt(++state2.position);
    } else {
      tagHandle = "!";
    }
    _position = state2.position;
    if (isVerbatim) {
      do {
        ch = state2.input.charCodeAt(++state2.position);
      } while (ch !== 0 && ch !== 62);
      if (state2.position < state2.length) {
        tagName = state2.input.slice(_position, state2.position);
        ch = state2.input.charCodeAt(++state2.position);
      } else {
        throwError(state2, "unexpected end of the stream within a verbatim tag");
      }
    } else {
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        if (ch === 33) {
          if (!isNamed) {
            tagHandle = state2.input.slice(_position - 1, state2.position + 1);
            if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
              throwError(state2, "named tag handle cannot contain such characters");
            }
            isNamed = true;
            _position = state2.position + 1;
          } else {
            throwError(state2, "tag suffix cannot contain exclamation marks");
          }
        }
        ch = state2.input.charCodeAt(++state2.position);
      }
      tagName = state2.input.slice(_position, state2.position);
      if (PATTERN_FLOW_INDICATORS.test(tagName)) {
        throwError(state2, "tag suffix cannot contain flow indicator characters");
      }
    }
    if (tagName && !PATTERN_TAG_URI.test(tagName)) {
      throwError(state2, "tag name cannot contain such characters: " + tagName);
    }
    try {
      tagName = decodeURIComponent(tagName);
    } catch (err) {
      throwError(state2, "tag name is malformed: " + tagName);
    }
    if (isVerbatim) {
      state2.tag = tagName;
    } else if (_hasOwnProperty$1.call(state2.tagMap, tagHandle)) {
      state2.tag = state2.tagMap[tagHandle] + tagName;
    } else if (tagHandle === "!") {
      state2.tag = "!" + tagName;
    } else if (tagHandle === "!!") {
      state2.tag = "tag:yaml.org,2002:" + tagName;
    } else {
      throwError(state2, 'undeclared tag handle "' + tagHandle + '"');
    }
    return true;
  }
  function readAnchorProperty(state2) {
    var _position, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch !== 38) return false;
    if (state2.anchor !== null) {
      throwError(state2, "duplication of an anchor property");
    }
    ch = state2.input.charCodeAt(++state2.position);
    _position = state2.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
      ch = state2.input.charCodeAt(++state2.position);
    }
    if (state2.position === _position) {
      throwError(state2, "name of an anchor node must contain at least one character");
    }
    state2.anchor = state2.input.slice(_position, state2.position);
    return true;
  }
  function readAlias(state2) {
    var _position, alias, ch;
    ch = state2.input.charCodeAt(state2.position);
    if (ch !== 42) return false;
    ch = state2.input.charCodeAt(++state2.position);
    _position = state2.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
      ch = state2.input.charCodeAt(++state2.position);
    }
    if (state2.position === _position) {
      throwError(state2, "name of an alias node must contain at least one character");
    }
    alias = state2.input.slice(_position, state2.position);
    if (!_hasOwnProperty$1.call(state2.anchorMap, alias)) {
      throwError(state2, 'unidentified alias "' + alias + '"');
    }
    state2.result = state2.anchorMap[alias];
    skipSeparationSpace(state2, true, -1);
    return true;
  }
  function composeNode(state2, parentIndent, nodeContext, allowToSeek, allowCompact) {
    var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, typeList, type2, flowIndent, blockIndent;
    if (state2.listener !== null) {
      state2.listener("open", state2);
    }
    state2.tag = null;
    state2.anchor = null;
    state2.kind = null;
    state2.result = null;
    allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
    if (allowToSeek) {
      if (skipSeparationSpace(state2, true, -1)) {
        atNewLine = true;
        if (state2.lineIndent > parentIndent) {
          indentStatus = 1;
        } else if (state2.lineIndent === parentIndent) {
          indentStatus = 0;
        } else if (state2.lineIndent < parentIndent) {
          indentStatus = -1;
        }
      }
    }
    if (indentStatus === 1) {
      while (readTagProperty(state2) || readAnchorProperty(state2)) {
        if (skipSeparationSpace(state2, true, -1)) {
          atNewLine = true;
          allowBlockCollections = allowBlockStyles;
          if (state2.lineIndent > parentIndent) {
            indentStatus = 1;
          } else if (state2.lineIndent === parentIndent) {
            indentStatus = 0;
          } else if (state2.lineIndent < parentIndent) {
            indentStatus = -1;
          }
        } else {
          allowBlockCollections = false;
        }
      }
    }
    if (allowBlockCollections) {
      allowBlockCollections = atNewLine || allowCompact;
    }
    if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
      if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
        flowIndent = parentIndent;
      } else {
        flowIndent = parentIndent + 1;
      }
      blockIndent = state2.position - state2.lineStart;
      if (indentStatus === 1) {
        if (allowBlockCollections && (readBlockSequence(state2, blockIndent) || readBlockMapping(state2, blockIndent, flowIndent)) || readFlowCollection(state2, flowIndent)) {
          hasContent = true;
        } else {
          if (allowBlockScalars && readBlockScalar(state2, flowIndent) || readSingleQuotedScalar(state2, flowIndent) || readDoubleQuotedScalar(state2, flowIndent)) {
            hasContent = true;
          } else if (readAlias(state2)) {
            hasContent = true;
            if (state2.tag !== null || state2.anchor !== null) {
              throwError(state2, "alias node should not have any properties");
            }
          } else if (readPlainScalar(state2, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
            hasContent = true;
            if (state2.tag === null) {
              state2.tag = "?";
            }
          }
          if (state2.anchor !== null) {
            state2.anchorMap[state2.anchor] = state2.result;
          }
        }
      } else if (indentStatus === 0) {
        hasContent = allowBlockCollections && readBlockSequence(state2, blockIndent);
      }
    }
    if (state2.tag === null) {
      if (state2.anchor !== null) {
        state2.anchorMap[state2.anchor] = state2.result;
      }
    } else if (state2.tag === "?") {
      if (state2.result !== null && state2.kind !== "scalar") {
        throwError(state2, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state2.kind + '"');
      }
      for (typeIndex = 0, typeQuantity = state2.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
        type2 = state2.implicitTypes[typeIndex];
        if (type2.resolve(state2.result)) {
          state2.result = type2.construct(state2.result);
          state2.tag = type2.tag;
          if (state2.anchor !== null) {
            state2.anchorMap[state2.anchor] = state2.result;
          }
          break;
        }
      }
    } else if (state2.tag !== "!") {
      if (_hasOwnProperty$1.call(state2.typeMap[state2.kind || "fallback"], state2.tag)) {
        type2 = state2.typeMap[state2.kind || "fallback"][state2.tag];
      } else {
        type2 = null;
        typeList = state2.typeMap.multi[state2.kind || "fallback"];
        for (typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) {
          if (state2.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
            type2 = typeList[typeIndex];
            break;
          }
        }
      }
      if (!type2) {
        throwError(state2, "unknown tag !<" + state2.tag + ">");
      }
      if (state2.result !== null && type2.kind !== state2.kind) {
        throwError(state2, "unacceptable node kind for !<" + state2.tag + '> tag; it should be "' + type2.kind + '", not "' + state2.kind + '"');
      }
      if (!type2.resolve(state2.result, state2.tag)) {
        throwError(state2, "cannot resolve a node with !<" + state2.tag + "> explicit tag");
      } else {
        state2.result = type2.construct(state2.result, state2.tag);
        if (state2.anchor !== null) {
          state2.anchorMap[state2.anchor] = state2.result;
        }
      }
    }
    if (state2.listener !== null) {
      state2.listener("close", state2);
    }
    return state2.tag !== null || state2.anchor !== null || hasContent;
  }
  function readDocument(state2) {
    var documentStart = state2.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
    state2.version = null;
    state2.checkLineBreaks = state2.legacy;
    state2.tagMap = /* @__PURE__ */ Object.create(null);
    state2.anchorMap = /* @__PURE__ */ Object.create(null);
    while ((ch = state2.input.charCodeAt(state2.position)) !== 0) {
      skipSeparationSpace(state2, true, -1);
      ch = state2.input.charCodeAt(state2.position);
      if (state2.lineIndent > 0 || ch !== 37) {
        break;
      }
      hasDirectives = true;
      ch = state2.input.charCodeAt(++state2.position);
      _position = state2.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        ch = state2.input.charCodeAt(++state2.position);
      }
      directiveName = state2.input.slice(_position, state2.position);
      directiveArgs = [];
      if (directiveName.length < 1) {
        throwError(state2, "directive name must not be less than one character in length");
      }
      while (ch !== 0) {
        while (is_WHITE_SPACE(ch)) {
          ch = state2.input.charCodeAt(++state2.position);
        }
        if (ch === 35) {
          do {
            ch = state2.input.charCodeAt(++state2.position);
          } while (ch !== 0 && !is_EOL(ch));
          break;
        }
        if (is_EOL(ch)) break;
        _position = state2.position;
        while (ch !== 0 && !is_WS_OR_EOL(ch)) {
          ch = state2.input.charCodeAt(++state2.position);
        }
        directiveArgs.push(state2.input.slice(_position, state2.position));
      }
      if (ch !== 0) readLineBreak(state2);
      if (_hasOwnProperty$1.call(directiveHandlers, directiveName)) {
        directiveHandlers[directiveName](state2, directiveName, directiveArgs);
      } else {
        throwWarning(state2, 'unknown document directive "' + directiveName + '"');
      }
    }
    skipSeparationSpace(state2, true, -1);
    if (state2.lineIndent === 0 && state2.input.charCodeAt(state2.position) === 45 && state2.input.charCodeAt(state2.position + 1) === 45 && state2.input.charCodeAt(state2.position + 2) === 45) {
      state2.position += 3;
      skipSeparationSpace(state2, true, -1);
    } else if (hasDirectives) {
      throwError(state2, "directives end mark is expected");
    }
    composeNode(state2, state2.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
    skipSeparationSpace(state2, true, -1);
    if (state2.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state2.input.slice(documentStart, state2.position))) {
      throwWarning(state2, "non-ASCII line breaks are interpreted as content");
    }
    state2.documents.push(state2.result);
    if (state2.position === state2.lineStart && testDocumentSeparator(state2)) {
      if (state2.input.charCodeAt(state2.position) === 46) {
        state2.position += 3;
        skipSeparationSpace(state2, true, -1);
      }
      return;
    }
    if (state2.position < state2.length - 1) {
      throwError(state2, "end of the stream or a document separator is expected");
    } else {
      return;
    }
  }
  function loadDocuments(input, options) {
    input = String(input);
    options = options || {};
    if (input.length !== 0) {
      if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) {
        input += "\n";
      }
      if (input.charCodeAt(0) === 65279) {
        input = input.slice(1);
      }
    }
    var state2 = new State$1(input, options);
    var nullpos = input.indexOf("\0");
    if (nullpos !== -1) {
      state2.position = nullpos;
      throwError(state2, "null byte is not allowed in input");
    }
    state2.input += "\0";
    while (state2.input.charCodeAt(state2.position) === 32) {
      state2.lineIndent += 1;
      state2.position += 1;
    }
    while (state2.position < state2.length - 1) {
      readDocument(state2);
    }
    return state2.documents;
  }
  function loadAll$1(input, iterator, options) {
    if (iterator !== null && typeof iterator === "object" && typeof options === "undefined") {
      options = iterator;
      iterator = null;
    }
    var documents = loadDocuments(input, options);
    if (typeof iterator !== "function") {
      return documents;
    }
    for (var index = 0, length = documents.length; index < length; index += 1) {
      iterator(documents[index]);
    }
  }
  function load$1(input, options) {
    var documents = loadDocuments(input, options);
    if (documents.length === 0) {
      return void 0;
    } else if (documents.length === 1) {
      return documents[0];
    }
    throw new exception("expected a single document in the stream, but found more");
  }
  var loadAll_1 = loadAll$1;
  var load_1 = load$1;
  var loader = {
    loadAll: loadAll_1,
    load: load_1
  };
  var _toString = Object.prototype.toString;
  var _hasOwnProperty = Object.prototype.hasOwnProperty;
  var CHAR_BOM = 65279;
  var CHAR_TAB = 9;
  var CHAR_LINE_FEED = 10;
  var CHAR_CARRIAGE_RETURN = 13;
  var CHAR_SPACE = 32;
  var CHAR_EXCLAMATION = 33;
  var CHAR_DOUBLE_QUOTE = 34;
  var CHAR_SHARP = 35;
  var CHAR_PERCENT = 37;
  var CHAR_AMPERSAND = 38;
  var CHAR_SINGLE_QUOTE = 39;
  var CHAR_ASTERISK = 42;
  var CHAR_COMMA = 44;
  var CHAR_MINUS = 45;
  var CHAR_COLON = 58;
  var CHAR_EQUALS = 61;
  var CHAR_GREATER_THAN = 62;
  var CHAR_QUESTION = 63;
  var CHAR_COMMERCIAL_AT = 64;
  var CHAR_LEFT_SQUARE_BRACKET = 91;
  var CHAR_RIGHT_SQUARE_BRACKET = 93;
  var CHAR_GRAVE_ACCENT = 96;
  var CHAR_LEFT_CURLY_BRACKET = 123;
  var CHAR_VERTICAL_LINE = 124;
  var CHAR_RIGHT_CURLY_BRACKET = 125;
  var ESCAPE_SEQUENCES = {};
  ESCAPE_SEQUENCES[0] = "\\0";
  ESCAPE_SEQUENCES[7] = "\\a";
  ESCAPE_SEQUENCES[8] = "\\b";
  ESCAPE_SEQUENCES[9] = "\\t";
  ESCAPE_SEQUENCES[10] = "\\n";
  ESCAPE_SEQUENCES[11] = "\\v";
  ESCAPE_SEQUENCES[12] = "\\f";
  ESCAPE_SEQUENCES[13] = "\\r";
  ESCAPE_SEQUENCES[27] = "\\e";
  ESCAPE_SEQUENCES[34] = '\\"';
  ESCAPE_SEQUENCES[92] = "\\\\";
  ESCAPE_SEQUENCES[133] = "\\N";
  ESCAPE_SEQUENCES[160] = "\\_";
  ESCAPE_SEQUENCES[8232] = "\\L";
  ESCAPE_SEQUENCES[8233] = "\\P";
  var DEPRECATED_BOOLEANS_SYNTAX = [
    "y",
    "Y",
    "yes",
    "Yes",
    "YES",
    "on",
    "On",
    "ON",
    "n",
    "N",
    "no",
    "No",
    "NO",
    "off",
    "Off",
    "OFF"
  ];
  var DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
  function compileStyleMap(schema2, map2) {
    var result, keys, index, length, tag, style, type2;
    if (map2 === null) return {};
    result = {};
    keys = Object.keys(map2);
    for (index = 0, length = keys.length; index < length; index += 1) {
      tag = keys[index];
      style = String(map2[tag]);
      if (tag.slice(0, 2) === "!!") {
        tag = "tag:yaml.org,2002:" + tag.slice(2);
      }
      type2 = schema2.compiledTypeMap["fallback"][tag];
      if (type2 && _hasOwnProperty.call(type2.styleAliases, style)) {
        style = type2.styleAliases[style];
      }
      result[tag] = style;
    }
    return result;
  }
  function encodeHex(character) {
    var string, handle, length;
    string = character.toString(16).toUpperCase();
    if (character <= 255) {
      handle = "x";
      length = 2;
    } else if (character <= 65535) {
      handle = "u";
      length = 4;
    } else if (character <= 4294967295) {
      handle = "U";
      length = 8;
    } else {
      throw new exception("code point within a string may not be greater than 0xFFFFFFFF");
    }
    return "\\" + handle + common.repeat("0", length - string.length) + string;
  }
  var QUOTING_TYPE_SINGLE = 1;
  var QUOTING_TYPE_DOUBLE = 2;
  function State(options) {
    this.schema = options["schema"] || _default;
    this.indent = Math.max(1, options["indent"] || 2);
    this.noArrayIndent = options["noArrayIndent"] || false;
    this.skipInvalid = options["skipInvalid"] || false;
    this.flowLevel = common.isNothing(options["flowLevel"]) ? -1 : options["flowLevel"];
    this.styleMap = compileStyleMap(this.schema, options["styles"] || null);
    this.sortKeys = options["sortKeys"] || false;
    this.lineWidth = options["lineWidth"] || 80;
    this.noRefs = options["noRefs"] || false;
    this.noCompatMode = options["noCompatMode"] || false;
    this.condenseFlow = options["condenseFlow"] || false;
    this.quotingType = options["quotingType"] === '"' ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
    this.forceQuotes = options["forceQuotes"] || false;
    this.replacer = typeof options["replacer"] === "function" ? options["replacer"] : null;
    this.implicitTypes = this.schema.compiledImplicit;
    this.explicitTypes = this.schema.compiledExplicit;
    this.tag = null;
    this.result = "";
    this.duplicates = [];
    this.usedDuplicates = null;
  }
  function indentString(string, spaces) {
    var ind = common.repeat(" ", spaces), position = 0, next = -1, result = "", line, length = string.length;
    while (position < length) {
      next = string.indexOf("\n", position);
      if (next === -1) {
        line = string.slice(position);
        position = length;
      } else {
        line = string.slice(position, next + 1);
        position = next + 1;
      }
      if (line.length && line !== "\n") result += ind;
      result += line;
    }
    return result;
  }
  function generateNextLine(state2, level) {
    return "\n" + common.repeat(" ", state2.indent * level);
  }
  function testImplicitResolving(state2, str2) {
    var index, length, type2;
    for (index = 0, length = state2.implicitTypes.length; index < length; index += 1) {
      type2 = state2.implicitTypes[index];
      if (type2.resolve(str2)) {
        return true;
      }
    }
    return false;
  }
  function isWhitespace(c) {
    return c === CHAR_SPACE || c === CHAR_TAB;
  }
  function isPrintable(c) {
    return 32 <= c && c <= 126 || 161 <= c && c <= 55295 && c !== 8232 && c !== 8233 || 57344 <= c && c <= 65533 && c !== CHAR_BOM || 65536 <= c && c <= 1114111;
  }
  function isNsCharOrWhitespace(c) {
    return isPrintable(c) && c !== CHAR_BOM && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
  }
  function isPlainSafe(c, prev, inblock) {
    var cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
    var cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
    return (
      // ns-plain-safe
      (inblock ? (
        // c = flow-in
        cIsNsCharOrWhitespace
      ) : cIsNsCharOrWhitespace && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET) && c !== CHAR_SHARP && !(prev === CHAR_COLON && !cIsNsChar) || isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP || prev === CHAR_COLON && cIsNsChar
    );
  }
  function isPlainSafeFirst(c) {
    return isPrintable(c) && c !== CHAR_BOM && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
  }
  function isPlainSafeLast(c) {
    return !isWhitespace(c) && c !== CHAR_COLON;
  }
  function codePointAt(string, pos) {
    var first = string.charCodeAt(pos), second;
    if (first >= 55296 && first <= 56319 && pos + 1 < string.length) {
      second = string.charCodeAt(pos + 1);
      if (second >= 56320 && second <= 57343) {
        return (first - 55296) * 1024 + second - 56320 + 65536;
      }
    }
    return first;
  }
  function needIndentIndicator(string) {
    var leadingSpaceRe = /^\n* /;
    return leadingSpaceRe.test(string);
  }
  var STYLE_PLAIN = 1;
  var STYLE_SINGLE = 2;
  var STYLE_LITERAL = 3;
  var STYLE_FOLDED = 4;
  var STYLE_DOUBLE = 5;
  function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType, quotingType, forceQuotes, inblock) {
    var i;
    var char = 0;
    var prevChar = null;
    var hasLineBreak = false;
    var hasFoldableLine = false;
    var shouldTrackWidth = lineWidth !== -1;
    var previousLineBreak = -1;
    var plain = isPlainSafeFirst(codePointAt(string, 0)) && isPlainSafeLast(codePointAt(string, string.length - 1));
    if (singleLineOnly || forceQuotes) {
      for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
        char = codePointAt(string, i);
        if (!isPrintable(char)) {
          return STYLE_DOUBLE;
        }
        plain = plain && isPlainSafe(char, prevChar, inblock);
        prevChar = char;
      }
    } else {
      for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
        char = codePointAt(string, i);
        if (char === CHAR_LINE_FEED) {
          hasLineBreak = true;
          if (shouldTrackWidth) {
            hasFoldableLine = hasFoldableLine || // Foldable line = too long, and not more-indented.
            i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
            previousLineBreak = i;
          }
        } else if (!isPrintable(char)) {
          return STYLE_DOUBLE;
        }
        plain = plain && isPlainSafe(char, prevChar, inblock);
        prevChar = char;
      }
      hasFoldableLine = hasFoldableLine || shouldTrackWidth && (i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ");
    }
    if (!hasLineBreak && !hasFoldableLine) {
      if (plain && !forceQuotes && !testAmbiguousType(string)) {
        return STYLE_PLAIN;
      }
      return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
    }
    if (indentPerLevel > 9 && needIndentIndicator(string)) {
      return STYLE_DOUBLE;
    }
    if (!forceQuotes) {
      return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
    }
    return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
  }
  function writeScalar(state2, string, level, iskey, inblock) {
    state2.dump = (function() {
      if (string.length === 0) {
        return state2.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''";
      }
      if (!state2.noCompatMode) {
        if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) {
          return state2.quotingType === QUOTING_TYPE_DOUBLE ? '"' + string + '"' : "'" + string + "'";
        }
      }
      var indent = state2.indent * Math.max(1, level);
      var lineWidth = state2.lineWidth === -1 ? -1 : Math.max(Math.min(state2.lineWidth, 40), state2.lineWidth - indent);
      var singleLineOnly = iskey || state2.flowLevel > -1 && level >= state2.flowLevel;
      function testAmbiguity(string2) {
        return testImplicitResolving(state2, string2);
      }
      switch (chooseScalarStyle(
        string,
        singleLineOnly,
        state2.indent,
        lineWidth,
        testAmbiguity,
        state2.quotingType,
        state2.forceQuotes && !iskey,
        inblock
      )) {
        case STYLE_PLAIN:
          return string;
        case STYLE_SINGLE:
          return "'" + string.replace(/'/g, "''") + "'";
        case STYLE_LITERAL:
          return "|" + blockHeader(string, state2.indent) + dropEndingNewline(indentString(string, indent));
        case STYLE_FOLDED:
          return ">" + blockHeader(string, state2.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
        case STYLE_DOUBLE:
          return '"' + escapeString(string) + '"';
        default:
          throw new exception("impossible error: invalid scalar style");
      }
    })();
  }
  function blockHeader(string, indentPerLevel) {
    var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
    var clip = string[string.length - 1] === "\n";
    var keep = clip && (string[string.length - 2] === "\n" || string === "\n");
    var chomp = keep ? "+" : clip ? "" : "-";
    return indentIndicator + chomp + "\n";
  }
  function dropEndingNewline(string) {
    return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
  }
  function foldString(string, width) {
    var lineRe = /(\n+)([^\n]*)/g;
    var result = (function() {
      var nextLF = string.indexOf("\n");
      nextLF = nextLF !== -1 ? nextLF : string.length;
      lineRe.lastIndex = nextLF;
      return foldLine(string.slice(0, nextLF), width);
    })();
    var prevMoreIndented = string[0] === "\n" || string[0] === " ";
    var moreIndented;
    var match;
    while (match = lineRe.exec(string)) {
      var prefix = match[1], line = match[2];
      moreIndented = line[0] === " ";
      result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
      prevMoreIndented = moreIndented;
    }
    return result;
  }
  function foldLine(line, width) {
    if (line === "" || line[0] === " ") return line;
    var breakRe = / [^ ]/g;
    var match;
    var start = 0, end, curr = 0, next = 0;
    var result = "";
    while (match = breakRe.exec(line)) {
      next = match.index;
      if (next - start > width) {
        end = curr > start ? curr : next;
        result += "\n" + line.slice(start, end);
        start = end + 1;
      }
      curr = next;
    }
    result += "\n";
    if (line.length - start > width && curr > start) {
      result += line.slice(start, curr) + "\n" + line.slice(curr + 1);
    } else {
      result += line.slice(start);
    }
    return result.slice(1);
  }
  function escapeString(string) {
    var result = "";
    var char = 0;
    var escapeSeq;
    for (var i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      escapeSeq = ESCAPE_SEQUENCES[char];
      if (!escapeSeq && isPrintable(char)) {
        result += string[i];
        if (char >= 65536) result += string[i + 1];
      } else {
        result += escapeSeq || encodeHex(char);
      }
    }
    return result;
  }
  function writeFlowSequence(state2, level, object) {
    var _result = "", _tag = state2.tag, index, length, value;
    for (index = 0, length = object.length; index < length; index += 1) {
      value = object[index];
      if (state2.replacer) {
        value = state2.replacer.call(object, String(index), value);
      }
      if (writeNode(state2, level, value, false, false) || typeof value === "undefined" && writeNode(state2, level, null, false, false)) {
        if (_result !== "") _result += "," + (!state2.condenseFlow ? " " : "");
        _result += state2.dump;
      }
    }
    state2.tag = _tag;
    state2.dump = "[" + _result + "]";
  }
  function writeBlockSequence(state2, level, object, compact) {
    var _result = "", _tag = state2.tag, index, length, value;
    for (index = 0, length = object.length; index < length; index += 1) {
      value = object[index];
      if (state2.replacer) {
        value = state2.replacer.call(object, String(index), value);
      }
      if (writeNode(state2, level + 1, value, true, true, false, true) || typeof value === "undefined" && writeNode(state2, level + 1, null, true, true, false, true)) {
        if (!compact || _result !== "") {
          _result += generateNextLine(state2, level);
        }
        if (state2.dump && CHAR_LINE_FEED === state2.dump.charCodeAt(0)) {
          _result += "-";
        } else {
          _result += "- ";
        }
        _result += state2.dump;
      }
    }
    state2.tag = _tag;
    state2.dump = _result || "[]";
  }
  function writeFlowMapping(state2, level, object) {
    var _result = "", _tag = state2.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
    for (index = 0, length = objectKeyList.length; index < length; index += 1) {
      pairBuffer = "";
      if (_result !== "") pairBuffer += ", ";
      if (state2.condenseFlow) pairBuffer += '"';
      objectKey = objectKeyList[index];
      objectValue = object[objectKey];
      if (state2.replacer) {
        objectValue = state2.replacer.call(object, objectKey, objectValue);
      }
      if (!writeNode(state2, level, objectKey, false, false)) {
        continue;
      }
      if (state2.dump.length > 1024) pairBuffer += "? ";
      pairBuffer += state2.dump + (state2.condenseFlow ? '"' : "") + ":" + (state2.condenseFlow ? "" : " ");
      if (!writeNode(state2, level, objectValue, false, false)) {
        continue;
      }
      pairBuffer += state2.dump;
      _result += pairBuffer;
    }
    state2.tag = _tag;
    state2.dump = "{" + _result + "}";
  }
  function writeBlockMapping(state2, level, object, compact) {
    var _result = "", _tag = state2.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
    if (state2.sortKeys === true) {
      objectKeyList.sort();
    } else if (typeof state2.sortKeys === "function") {
      objectKeyList.sort(state2.sortKeys);
    } else if (state2.sortKeys) {
      throw new exception("sortKeys must be a boolean or a function");
    }
    for (index = 0, length = objectKeyList.length; index < length; index += 1) {
      pairBuffer = "";
      if (!compact || _result !== "") {
        pairBuffer += generateNextLine(state2, level);
      }
      objectKey = objectKeyList[index];
      objectValue = object[objectKey];
      if (state2.replacer) {
        objectValue = state2.replacer.call(object, objectKey, objectValue);
      }
      if (!writeNode(state2, level + 1, objectKey, true, true, true)) {
        continue;
      }
      explicitPair = state2.tag !== null && state2.tag !== "?" || state2.dump && state2.dump.length > 1024;
      if (explicitPair) {
        if (state2.dump && CHAR_LINE_FEED === state2.dump.charCodeAt(0)) {
          pairBuffer += "?";
        } else {
          pairBuffer += "? ";
        }
      }
      pairBuffer += state2.dump;
      if (explicitPair) {
        pairBuffer += generateNextLine(state2, level);
      }
      if (!writeNode(state2, level + 1, objectValue, true, explicitPair)) {
        continue;
      }
      if (state2.dump && CHAR_LINE_FEED === state2.dump.charCodeAt(0)) {
        pairBuffer += ":";
      } else {
        pairBuffer += ": ";
      }
      pairBuffer += state2.dump;
      _result += pairBuffer;
    }
    state2.tag = _tag;
    state2.dump = _result || "{}";
  }
  function detectType(state2, object, explicit) {
    var _result, typeList, index, length, type2, style;
    typeList = explicit ? state2.explicitTypes : state2.implicitTypes;
    for (index = 0, length = typeList.length; index < length; index += 1) {
      type2 = typeList[index];
      if ((type2.instanceOf || type2.predicate) && (!type2.instanceOf || typeof object === "object" && object instanceof type2.instanceOf) && (!type2.predicate || type2.predicate(object))) {
        if (explicit) {
          if (type2.multi && type2.representName) {
            state2.tag = type2.representName(object);
          } else {
            state2.tag = type2.tag;
          }
        } else {
          state2.tag = "?";
        }
        if (type2.represent) {
          style = state2.styleMap[type2.tag] || type2.defaultStyle;
          if (_toString.call(type2.represent) === "[object Function]") {
            _result = type2.represent(object, style);
          } else if (_hasOwnProperty.call(type2.represent, style)) {
            _result = type2.represent[style](object, style);
          } else {
            throw new exception("!<" + type2.tag + '> tag resolver accepts not "' + style + '" style');
          }
          state2.dump = _result;
        }
        return true;
      }
    }
    return false;
  }
  function writeNode(state2, level, object, block, compact, iskey, isblockseq) {
    state2.tag = null;
    state2.dump = object;
    if (!detectType(state2, object, false)) {
      detectType(state2, object, true);
    }
    var type2 = _toString.call(state2.dump);
    var inblock = block;
    var tagStr;
    if (block) {
      block = state2.flowLevel < 0 || state2.flowLevel > level;
    }
    var objectOrArray = type2 === "[object Object]" || type2 === "[object Array]", duplicateIndex, duplicate;
    if (objectOrArray) {
      duplicateIndex = state2.duplicates.indexOf(object);
      duplicate = duplicateIndex !== -1;
    }
    if (state2.tag !== null && state2.tag !== "?" || duplicate || state2.indent !== 2 && level > 0) {
      compact = false;
    }
    if (duplicate && state2.usedDuplicates[duplicateIndex]) {
      state2.dump = "*ref_" + duplicateIndex;
    } else {
      if (objectOrArray && duplicate && !state2.usedDuplicates[duplicateIndex]) {
        state2.usedDuplicates[duplicateIndex] = true;
      }
      if (type2 === "[object Object]") {
        if (block && Object.keys(state2.dump).length !== 0) {
          writeBlockMapping(state2, level, state2.dump, compact);
          if (duplicate) {
            state2.dump = "&ref_" + duplicateIndex + state2.dump;
          }
        } else {
          writeFlowMapping(state2, level, state2.dump);
          if (duplicate) {
            state2.dump = "&ref_" + duplicateIndex + " " + state2.dump;
          }
        }
      } else if (type2 === "[object Array]") {
        if (block && state2.dump.length !== 0) {
          if (state2.noArrayIndent && !isblockseq && level > 0) {
            writeBlockSequence(state2, level - 1, state2.dump, compact);
          } else {
            writeBlockSequence(state2, level, state2.dump, compact);
          }
          if (duplicate) {
            state2.dump = "&ref_" + duplicateIndex + state2.dump;
          }
        } else {
          writeFlowSequence(state2, level, state2.dump);
          if (duplicate) {
            state2.dump = "&ref_" + duplicateIndex + " " + state2.dump;
          }
        }
      } else if (type2 === "[object String]") {
        if (state2.tag !== "?") {
          writeScalar(state2, state2.dump, level, iskey, inblock);
        }
      } else if (type2 === "[object Undefined]") {
        return false;
      } else {
        if (state2.skipInvalid) return false;
        throw new exception("unacceptable kind of an object to dump " + type2);
      }
      if (state2.tag !== null && state2.tag !== "?") {
        tagStr = encodeURI(
          state2.tag[0] === "!" ? state2.tag.slice(1) : state2.tag
        ).replace(/!/g, "%21");
        if (state2.tag[0] === "!") {
          tagStr = "!" + tagStr;
        } else if (tagStr.slice(0, 18) === "tag:yaml.org,2002:") {
          tagStr = "!!" + tagStr.slice(18);
        } else {
          tagStr = "!<" + tagStr + ">";
        }
        state2.dump = tagStr + " " + state2.dump;
      }
    }
    return true;
  }
  function getDuplicateReferences(object, state2) {
    var objects = [], duplicatesIndexes = [], index, length;
    inspectNode(object, objects, duplicatesIndexes);
    for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
      state2.duplicates.push(objects[duplicatesIndexes[index]]);
    }
    state2.usedDuplicates = new Array(length);
  }
  function inspectNode(object, objects, duplicatesIndexes) {
    var objectKeyList, index, length;
    if (object !== null && typeof object === "object") {
      index = objects.indexOf(object);
      if (index !== -1) {
        if (duplicatesIndexes.indexOf(index) === -1) {
          duplicatesIndexes.push(index);
        }
      } else {
        objects.push(object);
        if (Array.isArray(object)) {
          for (index = 0, length = object.length; index < length; index += 1) {
            inspectNode(object[index], objects, duplicatesIndexes);
          }
        } else {
          objectKeyList = Object.keys(object);
          for (index = 0, length = objectKeyList.length; index < length; index += 1) {
            inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
          }
        }
      }
    }
  }
  function dump$1(input, options) {
    options = options || {};
    var state2 = new State(options);
    if (!state2.noRefs) getDuplicateReferences(input, state2);
    var value = input;
    if (state2.replacer) {
      value = state2.replacer.call({ "": value }, "", value);
    }
    if (writeNode(state2, 0, value, true, true)) return state2.dump + "\n";
    return "";
  }
  var dump_1 = dump$1;
  var dumper = {
    dump: dump_1
  };
  function renamed(from, to) {
    return function() {
      throw new Error("Function yaml." + from + " is removed in js-yaml 4. Use yaml." + to + " instead, which is now safe by default.");
    };
  }
  var Type = type;
  var Schema = schema;
  var FAILSAFE_SCHEMA = failsafe;
  var JSON_SCHEMA = json;
  var CORE_SCHEMA = core;
  var DEFAULT_SCHEMA = _default;
  var load = loader.load;
  var loadAll = loader.loadAll;
  var dump = dumper.dump;
  var YAMLException = exception;
  var types = {
    binary,
    float,
    map,
    null: _null,
    pairs,
    set,
    timestamp,
    bool,
    int,
    merge,
    omap,
    seq,
    str
  };
  var safeLoad = renamed("safeLoad", "load");
  var safeLoadAll = renamed("safeLoadAll", "loadAll");
  var safeDump = renamed("safeDump", "dump");
  var jsYaml = {
    Type,
    Schema,
    FAILSAFE_SCHEMA,
    JSON_SCHEMA,
    CORE_SCHEMA,
    DEFAULT_SCHEMA,
    load,
    loadAll,
    dump,
    YAMLException,
    types,
    safeLoad,
    safeLoadAll,
    safeDump
  };

  // src/inline.ts
  var MARKDOWN_LINK_RE = /\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/g;
  function inlineToHtml(src) {
    let text = escapeHtml(src);
    const codeSpans = [];
    const PH_OPEN = String.fromCharCode(2);
    const PH_CLOSE = String.fromCharCode(3);
    text = text.replace(/`([^`]+)`/g, (_m, body) => {
      const i = codeSpans.push("<code>" + body + "</code>") - 1;
      return PH_OPEN + i + PH_CLOSE;
    });
    text = unescapeMarkdownTextEscapes(text);
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    text = text.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");
    text = text.replace(
      MARKDOWN_LINK_RE,
      (_m, label, href) => `<a href="${escapeAttr(href)}">${unescapeMarkdownLinkLabel(label)}</a>`
    );
    text = text.replace(
      /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g,
      (_m, id) => `<a class="noma-ref" href="#${escapeAttr(id)}">${id}</a>`
    );
    text = text.replace(/(?:  +|\\)\n/g, "<br />");
    text = text.replace(/\n/g, " ");
    const restoreRe = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g");
    text = text.replace(restoreRe, (_m, i) => codeSpans[Number(i)] ?? "");
    return text;
  }
  function inlineToPlain(src) {
    const codeSpans = [];
    const PH_OPEN = String.fromCharCode(2);
    const PH_CLOSE = String.fromCharCode(3);
    let text = src.replace(/`([^`]+)`/g, (_m, body) => {
      const i = codeSpans.push(body) - 1;
      return PH_OPEN + i + PH_CLOSE;
    });
    text = unescapeMarkdownTextEscapes(text).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/\b_([^_]+)_\b/g, "$1").replace(MARKDOWN_LINK_RE, (_m, label, href) => `${unescapeMarkdownLinkLabel(label)} (${href})`).replace(/\[\[([a-zA-Z_][\w\-./:]*)\]\]/g, "$1");
    const restoreRe = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g");
    return text.replace(restoreRe, (_m, i) => codeSpans[Number(i)] ?? "");
  }
  function unescapeMarkdownLinkLabel(label) {
    return label.replace(/\\([\\[\]|])/g, "$1");
  }
  function unescapeMarkdownTextEscapes(text) {
    return text.replace(/\\\|/g, "|");
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }
  function splitPipeRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let buf = "";
    let inBacktick = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "\\" && trimmed[i + 1] === "|") {
        buf += "\\|";
        i++;
        continue;
      }
      if (ch === "`") {
        inBacktick = !inBacktick;
        buf += ch;
        continue;
      }
      if (ch === "|" && !inBacktick) {
        cells.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    cells.push(buf.trim());
    return cells;
  }
  function splitDelimitedRow(line, delimiter) {
    const cells = [];
    let buf = "";
    let inQuotes = false;
    let quotedCell = false;
    let afterClosingQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          buf += '"';
          i++;
          continue;
        }
        if (ch === '"') {
          inQuotes = false;
          quotedCell = true;
          afterClosingQuote = true;
          continue;
        }
        buf += ch;
        continue;
      }
      if (ch === delimiter) {
        cells.push(quotedCell ? buf : buf.trim());
        buf = "";
        quotedCell = false;
        afterClosingQuote = false;
        continue;
      }
      if (ch === '"' && buf.trim() === "" && !quotedCell) {
        buf = "";
        inQuotes = true;
        continue;
      }
      if (afterClosingQuote && /\s/.test(ch)) continue;
      afterClosingQuote = false;
      buf += ch;
    }
    cells.push(quotedCell ? buf : buf.trim());
    return cells;
  }

  // src/parser.ts
  var FRONTMATTER_RE = /^---\s*$/;
  var HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+\{([^}]+)\})?\s*$/;
  var FENCE_RE = /^```(\w*)\s*$/;
  var DIRECTIVE_OPEN_RE = /^(:{2,})\s*([a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)\s*(\{.*\})?\s*$/;
  var DIRECTIVE_CLOSE_RE = /^(:{2,})\s*$/;
  var LIST_RE = /^([-*])\s+(.+)$/;
  var ORDERED_LIST_RE = /^(\d+)\.\s+(.+)$/;
  var QUOTE_RE = /^>\s?(.*)$/;
  var THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
  var TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  var matchOnce = (re, s) => s.match(re);
  function parse(source, options = {}) {
    const normalized = source.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    const { meta, raw, startLine, endLine: fmEnd } = extractFrontmatter(lines);
    const flatChildren = parseBlocks(lines, startLine, lines.length, 0);
    const children = foldSections(flatChildren);
    for (const c of children) computeSectionEndLines(c);
    if (raw !== "") {
      const fmNode = {
        type: "frontmatter",
        data: meta,
        raw,
        pos: { line: 1, column: 1 },
        endLine: fmEnd
      };
      children.unshift(fmNode);
    }
    attachChapterAliases(children, meta, options.filename);
    return {
      type: "document",
      pos: { line: 1, column: 1 },
      endLine: Math.max(1, lines.length - (normalized.endsWith("\n") ? 1 : 0)),
      meta: { ...options.filename ? { filename: options.filename } : {}, ...meta },
      children
    };
  }
  function attachChapterAliases(children, meta, filename) {
    const root = children.find((n) => n.type === "section" && n.level === 1);
    if (!root) return;
    const aliases = new Set(root.aliases ?? []);
    if (filename) {
      const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
      const stem = base.replace(/\.noma$/i, "").replace(/^\d+[-_]/, "");
      const slug = slugify(stem);
      if (slug && slug !== root.id) aliases.add(slug);
    }
    const fmAliases = meta.aliases;
    if (Array.isArray(fmAliases)) {
      for (const a of fmAliases) {
        if (typeof a === "string" && a.trim()) aliases.add(a.trim());
      }
    }
    if (aliases.size > 0) root.aliases = [...aliases];
  }
  function extractFrontmatter(lines) {
    if (lines.length === 0 || !FRONTMATTER_RE.test(lines[0] ?? "")) {
      return { meta: {}, raw: "", startLine: 0, endLine: 0 };
    }
    for (let i = 1; i < lines.length; i++) {
      if (FRONTMATTER_RE.test(lines[i] ?? "")) {
        const raw = lines.slice(1, i).join("\n");
        const parsed = jsYaml.load(raw);
        const meta = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        return { meta, raw, startLine: i + 1, endLine: i + 1 };
      }
    }
    return { meta: {}, raw: "", startLine: 0, endLine: 0 };
  }
  function parseBlocks(lines, from, to, parentColons) {
    const out = [];
    let i = from;
    while (i < to) {
      const line = lines[i] ?? "";
      if (line.trim() === "") {
        i++;
        continue;
      }
      const directiveOpen = matchOnce(DIRECTIVE_OPEN_RE, line);
      if (directiveOpen) {
        const colons = directiveOpen[1].length;
        if (colons > parentColons || parentColons === 0) {
          const result = parseDirective(lines, i, to, colons);
          out.push(result.node);
          i = result.next;
          continue;
        }
        out.push(paragraph(line, i));
        i++;
        continue;
      }
      if (matchOnce(DIRECTIVE_CLOSE_RE, line)) {
        out.push(paragraph(line, i));
        i++;
        continue;
      }
      const heading = matchOnce(HEADING_RE, line);
      if (heading) {
        const level = heading[1].length;
        const title = heading[2].trim();
        const headingAttrs = heading[3] ? parseAttrs(`{${heading[3]}}`) : {};
        const explicitId = typeof headingAttrs.id === "string" ? headingAttrs.id : void 0;
        const section = {
          type: "section",
          id: explicitId ?? slugify(title),
          level,
          title,
          children: [],
          pos: { line: i + 1, column: 1 }
        };
        if (!explicitId) section._idIsExplicit = false;
        else section._idIsExplicit = true;
        const aliasesAttr = headingAttrs.aliases;
        if (typeof aliasesAttr === "string") {
          const list = aliasesAttr.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean);
          if (list.length > 0) section.aliases = list;
        }
        out.push(section);
        i++;
        continue;
      }
      const fence = matchOnce(FENCE_RE, line);
      if (fence) {
        const lang = fence[1] || void 0;
        const start = i + 1;
        let end = start;
        while (end < to && !FENCE_RE.test(lines[end] ?? "")) end++;
        const content = lines.slice(start, end).join("\n");
        const closed = end < to;
        out.push({
          type: "code",
          lang,
          content,
          pos: { line: i + 1, column: 1 },
          endLine: closed ? end + 1 : end
        });
        i = closed ? end + 1 : end;
        continue;
      }
      if (TABLE_ROW_RE.test(line) && i + 1 < to && TABLE_SEPARATOR_RE.test(lines[i + 1] ?? "")) {
        const result = parseTable(lines, i, to);
        if (result) {
          result.node.endLine = result.next;
          out.push(result.node);
          i = result.next;
          continue;
        }
      }
      if (THEMATIC_BREAK_RE.test(line)) {
        out.push({
          type: "thematic_break",
          pos: { line: i + 1, column: 1 },
          endLine: i + 1
        });
        i++;
        continue;
      }
      if (QUOTE_RE.test(line)) {
        const buf2 = [];
        const startLine2 = i;
        while (i < to) {
          const m = matchOnce(QUOTE_RE, lines[i] ?? "");
          if (!m) break;
          buf2.push(m[1] ?? "");
          i++;
        }
        out.push({
          type: "quote",
          content: buf2.join("\n"),
          pos: { line: startLine2 + 1, column: 1 },
          endLine: i
        });
        continue;
      }
      if (LIST_RE.test(line) || ORDERED_LIST_RE.test(line)) {
        const ordered = ORDERED_LIST_RE.test(line);
        const items = [];
        const re = ordered ? ORDERED_LIST_RE : LIST_RE;
        const startLine2 = i;
        while (i < to) {
          const m = matchOnce(re, lines[i] ?? "");
          if (!m) break;
          items.push({
            type: "list_item",
            content: m[2] ?? "",
            pos: { line: i + 1, column: 1 },
            endLine: i + 1
          });
          i++;
        }
        out.push({
          type: "list",
          ordered,
          items,
          pos: { line: startLine2 + 1, column: 1 },
          endLine: i
        });
        continue;
      }
      const buf = [];
      const startLine = i;
      while (i < to) {
        const cur = lines[i] ?? "";
        const next = lines[i + 1] ?? "";
        if (cur.trim() === "" || HEADING_RE.test(cur) || FENCE_RE.test(cur) || DIRECTIVE_OPEN_RE.test(cur) || DIRECTIVE_CLOSE_RE.test(cur) || THEMATIC_BREAK_RE.test(cur) || QUOTE_RE.test(cur) || LIST_RE.test(cur) || ORDERED_LIST_RE.test(cur) || TABLE_ROW_RE.test(cur) && TABLE_SEPARATOR_RE.test(next)) {
          break;
        }
        buf.push(cur);
        i++;
      }
      if (buf.length > 0) out.push(paragraph(buf.join("\n"), startLine, i));
    }
    return out;
  }
  function parseDirective(lines, i, to, colons) {
    const opener = matchOnce(DIRECTIVE_OPEN_RE, lines[i] ?? "");
    const name = opener[2];
    const attrs = parseAttrs(opener[3] ?? "");
    let close = -1;
    for (let j = i + 1; j < to; j++) {
      const fence = matchOnce(FENCE_RE, lines[j] ?? "");
      if (fence) {
        j++;
        while (j < to && !FENCE_RE.test(lines[j] ?? "")) j++;
        continue;
      }
      const m = matchOnce(DIRECTIVE_CLOSE_RE, lines[j] ?? "");
      if (m && m[1].length === colons) {
        close = j;
        break;
      }
    }
    const innerEnd = close === -1 ? to : close;
    const children = parseBlocks(lines, i + 1, innerEnd, colons);
    const node = {
      type: "directive",
      name,
      attrs,
      children,
      pos: { line: i + 1, column: 1 },
      endLine: close === -1 ? to : close + 1
    };
    if (typeof attrs.id === "string") node.id = attrs.id;
    if (children.length === 1 && children[0].type === "paragraph") {
      node.body = children[0].content;
    }
    return { node, next: close === -1 ? to : close + 1 };
  }
  var splitRow = splitPipeRow;
  function parseTable(lines, i, to) {
    const headerLine = lines[i] ?? "";
    const sepLine = lines[i + 1] ?? "";
    const header = splitRow(headerLine);
    const sepCells = splitRow(sepLine);
    if (sepCells.length !== header.length) return null;
    const align = sepCells.map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
    const rows = [];
    let j = i + 2;
    while (j < to && TABLE_ROW_RE.test(lines[j] ?? "")) {
      const cells = splitRow(lines[j] ?? "");
      while (cells.length < header.length) cells.push("");
      if (cells.length > header.length) cells.length = header.length;
      rows.push(cells);
      j++;
    }
    return {
      node: {
        type: "table",
        header,
        align,
        rows,
        pos: { line: i + 1, column: 1 }
      },
      next: j
    };
  }
  function parseAttrs(raw) {
    const attrs = {};
    if (!raw) return attrs;
    const inner = raw.replace(/^\{/, "").replace(/\}$/, "").trim();
    if (!inner) return attrs;
    const re = /([a-zA-Z_][\w-]*)(?:=("([^"]*)"|'([^']*)'|([^\s]+)))?/g;
    for (const m of inner.matchAll(re)) {
      const key = m[1];
      if (m[2] === void 0) {
        attrs[key] = true;
        continue;
      }
      const quoted = m[3] ?? m[4];
      const bare = m[5];
      const value = quoted !== void 0 ? quoted : bare ?? "";
      attrs[key] = coerce(value);
    }
    return attrs;
  }
  function coerce(v) {
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d+\.\d+$/.test(v)) return Number(v);
    return v;
  }
  function paragraph(content, line, endIdx) {
    const lineCount = content.split("\n").length;
    return {
      type: "paragraph",
      content: content.replace(/\n+$/, ""),
      pos: { line: line + 1, column: 1 },
      endLine: endIdx !== void 0 ? endIdx : line + lineCount
    };
  }
  function computeSectionEndLines(node) {
    if (node.type === "section") {
      let end = node.pos?.line ?? 0;
      for (const c of node.children) {
        const ce = computeSectionEndLines(c);
        if (ce > end) end = ce;
      }
      node.endLine = end;
      return end;
    }
    if (node.type === "directive") {
      for (const c of node.children) computeSectionEndLines(c);
    }
    return node.endLine ?? node.pos?.line ?? 0;
  }
  function foldSections(nodes) {
    const root = [];
    const stack = [];
    const seenSlugSections = /* @__PURE__ */ new Set();
    const push = (node) => {
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else root.push(node);
    };
    for (const node of nodes) {
      if (node.type === "section") {
        const section = node;
        const isExplicit = section._idIsExplicit === true;
        if (!isExplicit) {
          const slug = section.id;
          if (seenSlugSections.has(slug)) {
            let n = 2;
            while (seenSlugSections.has(`${slug}-${n}`)) n++;
            section.id = `${slug}-${n}`;
            seenSlugSections.add(section.id);
          } else {
            seenSlugSections.add(slug);
          }
        }
        while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
          stack.pop();
        }
        push(node);
        stack.push(section);
        delete section._idIsExplicit;
        continue;
      }
      push(node);
    }
    return root;
  }
  function slugify(input) {
    return input.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }

  // src/formula.ts
  var FUNCTIONS = /* @__PURE__ */ new Set(["pow", "min", "max", "clamp", "round", "abs", "if"]);
  function parseFormula(source) {
    const parser = new FormulaParser(source);
    return parser.parse();
  }
  function evaluateFormula(ast, env = {}) {
    return evalNode(ast, env);
  }
  function extractFormulaIdentifiers(ast) {
    const out = /* @__PURE__ */ new Set();
    const visit = (node) => {
      switch (node.type) {
        case "number":
          return;
        case "identifier":
          out.add(node.name);
          return;
        case "unary":
          visit(node.expr);
          return;
        case "binary":
          visit(node.left);
          visit(node.right);
          return;
        case "call":
          for (const arg of node.args) visit(arg);
          return;
      }
    };
    visit(ast);
    return [...out].sort();
  }
  var FormulaParser = class {
    tokens;
    index = 0;
    constructor(source) {
      this.tokens = tokenize(source);
    }
    parse() {
      try {
        const ast = this.parseComparison();
        const next = this.peek();
        if (next.type !== "eof") throw this.error(`Unexpected token "${next.value}".`, next);
        return { ok: true, ast };
      } catch (error) {
        return { ok: false, error };
      }
    }
    parseComparison() {
      let left = this.parseAdditive();
      const next = this.peek();
      if (next.type === "operator" && (next.value === ">" || next.value === ">=" || next.value === "<" || next.value === "<=" || next.value === "==" || next.value === "!=")) {
        this.index++;
        const right = this.parseAdditive();
        left = { type: "binary", op: next.value, left, right };
      }
      return left;
    }
    parseAdditive() {
      let left = this.parseMultiplicative();
      while (this.matchOperator("+") || this.matchOperator("-")) {
        const op = this.previous().value;
        const right = this.parseMultiplicative();
        left = { type: "binary", op, left, right };
      }
      return left;
    }
    parseMultiplicative() {
      let left = this.parsePower();
      while (this.matchOperator("*") || this.matchOperator("/")) {
        const op = this.previous().value;
        const right = this.parsePower();
        left = { type: "binary", op, left, right };
      }
      return left;
    }
    parsePower() {
      const left = this.parseUnary();
      if (this.matchOperator("^")) {
        const right = this.parsePower();
        return { type: "binary", op: "^", left, right };
      }
      return left;
    }
    parseUnary() {
      if (this.matchOperator("+") || this.matchOperator("-")) {
        const op = this.previous().value;
        return { type: "unary", op, expr: this.parseUnary() };
      }
      return this.parsePrimary();
    }
    parsePrimary() {
      const token = this.peek();
      if (token.type === "number") {
        this.index++;
        const value = Number(token.value);
        if (!Number.isFinite(value)) throw this.error(`Invalid number "${token.value}".`, token);
        return { type: "number", value };
      }
      if (token.type === "identifier") {
        this.index++;
        if (this.match("lparen")) {
          if (!FUNCTIONS.has(token.value)) {
            throw this.error(`Unknown function "${token.value}".`, token);
          }
          const args = [];
          if (!this.match("rparen")) {
            do {
              args.push(this.parseComparison());
            } while (this.match("comma"));
            this.consume("rparen", "Expected ')' after function arguments.");
          }
          return { type: "call", name: token.value, args };
        }
        return { type: "identifier", name: token.value };
      }
      if (this.match("lparen")) {
        const expr = this.parseComparison();
        this.consume("rparen", "Expected ')' after expression.");
        return expr;
      }
      throw this.error("Expected a number, identifier, function call, or parenthesized expression.", token);
    }
    match(type2) {
      if (this.peek().type !== type2) return false;
      this.index++;
      return true;
    }
    matchOperator(value) {
      const token = this.peek();
      if (token.type !== "operator" || token.value !== value) return false;
      this.index++;
      return true;
    }
    consume(type2, message) {
      const token = this.peek();
      if (token.type === type2) {
        this.index++;
        return token;
      }
      throw this.error(message, token);
    }
    peek() {
      return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
    }
    previous() {
      return this.tokens[this.index - 1];
    }
    error(message, token) {
      return { message, pos: token.pos };
    }
  };
  function tokenize(source) {
    const tokens = [];
    let i = 0;
    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (isNumberStart(source, i)) {
        const start = i;
        i = readNumber(source, i);
        tokens.push({ type: "number", value: source.slice(start, i), pos: start });
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const start = i;
        i++;
        while (i < source.length && /[A-Za-z0-9_.-]/.test(source[i])) i++;
        tokens.push({ type: "identifier", value: source.slice(start, i), pos: start });
        continue;
      }
      if (ch === "(") {
        tokens.push({ type: "lparen", value: ch, pos: i++ });
        continue;
      }
      if (ch === ")") {
        tokens.push({ type: "rparen", value: ch, pos: i++ });
        continue;
      }
      if (ch === ",") {
        tokens.push({ type: "comma", value: ch, pos: i++ });
        continue;
      }
      const two = source.slice(i, i + 2);
      if (two === ">=" || two === "<=" || two === "==" || two === "!=") {
        tokens.push({ type: "operator", value: two, pos: i });
        i += 2;
        continue;
      }
      if ("+-*/^<>".includes(ch)) {
        tokens.push({ type: "operator", value: ch, pos: i++ });
        continue;
      }
      tokens.push({ type: "operator", value: ch, pos: i++ });
    }
    tokens.push({ type: "eof", value: "", pos: source.length });
    return tokens;
  }
  function isNumberStart(source, index) {
    const ch = source[index];
    if (/\d/.test(ch)) return true;
    return ch === "." && /\d/.test(source[index + 1] ?? "");
  }
  function readNumber(source, index) {
    let i = index;
    while (i < source.length && /\d/.test(source[i])) i++;
    if (source[i] === ".") {
      i++;
      while (i < source.length && /\d/.test(source[i])) i++;
    }
    if (source[i] === "e" || source[i] === "E") {
      const expStart = i;
      i++;
      if (source[i] === "+" || source[i] === "-") i++;
      const digitStart = i;
      while (i < source.length && /\d/.test(source[i])) i++;
      if (i === digitStart) return expStart;
    }
    return i;
  }
  function evalNode(node, env) {
    switch (node.type) {
      case "number":
        return finite(node.value, 0);
      case "identifier": {
        const value = env[node.name];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return { ok: false, error: { message: `Missing numeric value for "${node.name}".`, pos: 0 } };
        }
        return { ok: true, value };
      }
      case "unary": {
        const value = evalNode(node.expr, env);
        if (!value.ok) return value;
        return finite(node.op === "-" ? -value.value : value.value, 0);
      }
      case "binary":
        return evalBinary(node, env);
      case "call":
        return evalCall(node, env);
    }
  }
  function evalBinary(node, env) {
    const left = evalNode(node.left, env);
    if (!left.ok) return left;
    const right = evalNode(node.right, env);
    if (!right.ok) return right;
    switch (node.op) {
      case "+":
        return finite(left.value + right.value, 0);
      case "-":
        return finite(left.value - right.value, 0);
      case "*":
        return finite(left.value * right.value, 0);
      case "/":
        return right.value === 0 ? { ok: false, error: { message: "Division by zero.", pos: 0 } } : finite(left.value / right.value, 0);
      case "^":
        return finite(Math.pow(left.value, right.value), 0);
      case ">":
        return { ok: true, value: left.value > right.value ? 1 : 0 };
      case ">=":
        return { ok: true, value: left.value >= right.value ? 1 : 0 };
      case "<":
        return { ok: true, value: left.value < right.value ? 1 : 0 };
      case "<=":
        return { ok: true, value: left.value <= right.value ? 1 : 0 };
      case "==":
        return { ok: true, value: left.value === right.value ? 1 : 0 };
      case "!=":
        return { ok: true, value: left.value !== right.value ? 1 : 0 };
    }
  }
  function evalCall(node, env) {
    const args = [];
    for (const arg of node.args) {
      const value = evalNode(arg, env);
      if (!value.ok) return value;
      args.push(value.value);
    }
    switch (node.name) {
      case "pow":
        return arity(node, args, 2, 2) ?? finite(Math.pow(args[0], args[1]), 0);
      case "min":
        return arity(node, args, 1, Infinity) ?? finite(Math.min(...args), 0);
      case "max":
        return arity(node, args, 1, Infinity) ?? finite(Math.max(...args), 0);
      case "clamp":
        return arity(node, args, 3, 3) ?? finite(Math.min(Math.max(args[0], args[1]), args[2]), 0);
      case "round": {
        const arityError = arity(node, args, 1, 2);
        if (arityError) return arityError;
        const digits = args[1] ?? 0;
        const factor = Math.pow(10, Math.trunc(digits));
        return finite(Math.round(args[0] * factor) / factor, 0);
      }
      case "abs":
        return arity(node, args, 1, 1) ?? finite(Math.abs(args[0]), 0);
      case "if":
        return arity(node, args, 3, 3) ?? finite(args[0] !== 0 ? args[1] : args[2], 0);
    }
  }
  function arity(node, args, min, max) {
    if (args.length >= min && args.length <= max) return null;
    const expected = min === max ? String(min) : `${min}-${max === Infinity ? "many" : max}`;
    return { ok: false, error: { message: `${node.name}() expects ${expected} arguments, got ${args.length}.`, pos: 0 } };
  }
  function finite(value, pos) {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: { message: "Formula produced a non-finite result.", pos } };
  }

  // src/computed.ts
  function buildComputedEvalContext(doc) {
    const controls = /* @__PURE__ */ new Map();
    const computedNodes = /* @__PURE__ */ new Map();
    for (const node of walk(doc)) {
      if (node.type !== "directive" || !node.id) continue;
      if (node.name === "control") {
        const value = controlDefaultNumber(node);
        if (value !== void 0) controls.set(node.id, value);
      } else if (isComputedDirective(node)) {
        computedNodes.set(node.id, node);
      }
    }
    return { controls, computedNodes, cache: /* @__PURE__ */ new Map() };
  }
  function isComputedDirective(node) {
    return node.name === "computed_metric" || node.name === "computed_plot" || node.name === "computed_table";
  }
  function formulaText(node) {
    return stringAttr(node.attrs, "formula") ?? bodyFieldText(node, "formula");
  }
  function computedDomainText(node) {
    return stringAttr(node.attrs, "domain") ?? stringAttr(node.attrs, "range") ?? bodyFieldText(node, "domain") ?? bodyFieldText(node, "range");
  }
  function computedDomainVars(node) {
    const out = /* @__PURE__ */ new Set();
    const raw = computedDomainText(node);
    if (!raw) return out;
    for (const part of raw.split(/[,\s]+/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/.exec(part.trim());
      if (match) out.add(match[1]);
    }
    return out;
  }
  function parseComputedDomain(node) {
    const raw = computedDomainText(node);
    if (!raw) return null;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)(?:\s*:\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(raw);
    if (!match) return null;
    const variable = match[1];
    const start = Number(match[2]);
    const end = Number(match[3]);
    const explicitStep = match[4] !== void 0 ? Number(match[4]) : void 0;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const step = explicitStep ?? (Number.isInteger(start) && Number.isInteger(end) ? start <= end ? 1 : -1 : (end - start) / 10);
    if (!Number.isFinite(step) || step === 0) return null;
    const points = [];
    const forward = step > 0;
    for (let value = start; forward ? value <= end + 1e-9 : value >= end - 1e-9; value += step) {
      points.push(Number(value.toFixed(10)));
      if (points.length >= 25) break;
    }
    return points.length > 0 ? { variable, points } : null;
  }
  function evaluateComputedSeries(node, ctx) {
    const domain = parseComputedDomain(node);
    if (!domain) return null;
    const values = [];
    for (const point of domain.points) {
      const value = evaluateComputedNode(node, ctx, { [domain.variable]: point });
      if (value === void 0) return null;
      values.push(value);
    }
    return { variable: domain.variable, points: domain.points, values };
  }
  function evaluateComputedNode(node, ctx, extraEnv = {}) {
    return evaluateComputedNodeInner(node, ctx, /* @__PURE__ */ new Set(), extraEnv);
  }
  function formatComputedNumber(value) {
    if (Math.abs(value) >= 1e6) return value.toFixed(0);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  function controlDefaultText(node) {
    const value = node.attrs.default;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return bodyFieldText(node, "default");
  }
  function controlDefaultNumber(node) {
    const numeric = numericAttr(node.attrs, "default");
    if (numeric !== void 0) return numeric;
    const type2 = stringAttr(node.attrs, "type")?.toLowerCase();
    if (type2 !== "checkbox" && type2 !== "toggle") return void 0;
    const value = controlDefaultText(node)?.toLowerCase();
    if (value === "true" || value === "yes" || value === "on" || value === "checked") return 1;
    if (value === "false" || value === "no" || value === "off" || value === "unchecked") return 0;
    return void 0;
  }
  function controlOptions(node) {
    const raw = stringAttr(node.attrs, "options") ?? bodyFieldText(node, "options");
    if (!raw) return [];
    return raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const sep = item.indexOf("=");
      if (sep === -1) return { value: item, label: item };
      const value = item.slice(0, sep).trim();
      const label = item.slice(sep + 1).trim();
      return { value: value || label, label: label || value };
    }).filter((option) => option.value || option.label);
  }
  function numericAttr(attrs, key) {
    const value = attrs[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return void 0;
  }
  function stringAttr(attrs, key) {
    const value = attrs[key];
    return typeof value === "string" && value.trim() ? value.trim() : void 0;
  }
  function bodyFieldText(node, key) {
    const body = node.body ?? "";
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "i");
    const line = body.split(/\r?\n/).find((candidate) => pattern.test(candidate));
    return line?.replace(pattern, "").trim() || void 0;
  }
  function evaluateComputedNodeInner(node, ctx, seen, extraEnv) {
    let trackedId;
    if (node.id && !Object.prototype.hasOwnProperty.call(extraEnv, node.id)) {
      const cacheable = Object.keys(extraEnv).length === 0;
      const cached = cacheable ? ctx.cache.get(node.id) : void 0;
      if (cached !== void 0) return cached ?? void 0;
      if (seen.has(node.id)) {
        if (cacheable) ctx.cache.set(node.id, null);
        return void 0;
      }
      seen.add(node.id);
      trackedId = node.id;
    }
    const formula = formulaText(node);
    if (!formula) {
      if (trackedId) seen.delete(trackedId);
      return void 0;
    }
    const parsed = parseFormula(formula);
    if (!parsed.ok) {
      if (trackedId) seen.delete(trackedId);
      return void 0;
    }
    const env = { ...Object.fromEntries(ctx.controls), ...extraEnv };
    for (const id of extractFormulaIdentifiers(parsed.ast)) {
      if (Object.prototype.hasOwnProperty.call(env, id)) continue;
      const dep = ctx.computedNodes.get(id);
      if (!dep) continue;
      const value2 = evaluateComputedNodeInner(dep, ctx, seen, extraEnv);
      if (value2 !== void 0) env[id] = value2;
    }
    const evaluated = evaluateFormula(parsed.ast, env);
    const value = evaluated.ok ? evaluated.value : void 0;
    if (node.id && Object.keys(extraEnv).length === 0) ctx.cache.set(node.id, value ?? null);
    if (trackedId) seen.delete(trackedId);
    return value;
  }
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // src/renderer-html.ts
  function buildDatasetRegistry(doc) {
    const out = /* @__PURE__ */ new Map();
    for (const node of walk(doc)) {
      if (node.type !== "directive" || node.name !== "dataset" || !node.id) continue;
      const table = parseDatasetBody(node);
      if (table) out.set(node.id, table);
    }
    return out;
  }
  function collectCitationEntries(doc) {
    const out = [];
    for (const node of walk(doc)) {
      if (node.type !== "directive" || node.name !== "citation") continue;
      const entry = {};
      if (node.id) entry.id = node.id;
      const source = stringAttr2(node.attrs, "source");
      const title = stringAttr2(node.attrs, "title");
      const url = stringAttr2(node.attrs, "url") ?? stringAttr2(node.attrs, "href");
      const doi = stringAttr2(node.attrs, "doi");
      const accessed = stringAttr2(node.attrs, "accessed");
      const body = directiveText(node);
      if (source) entry.source = source;
      if (title) entry.title = title;
      if (url) entry.url = url;
      if (doi) entry.doi = doi;
      if (accessed) entry.accessed = accessed;
      if (body) entry.body = body;
      out.push(entry);
    }
    return out;
  }
  function collectSectionEntries(doc) {
    const out = [];
    for (const node of walk(doc)) {
      if (node.type !== "section") continue;
      out.push({ id: node.id, title: node.title, level: node.level });
    }
    return out;
  }
  function collectCaptionEntries(doc) {
    const out = [];
    for (const node of walk(doc)) {
      if (node.type !== "directive") continue;
      const entry = captionEntry(node);
      if (entry) out.push(entry);
    }
    return out;
  }
  function captionEntry(node) {
    if (node.name === "figure") {
      return {
        ...node.id ? { id: node.id } : {},
        kind: "figures",
        title: stringAttr2(node.attrs, "caption") ?? stringAttr2(node.attrs, "title") ?? "Figure"
      };
    }
    if (node.name === "plot" || node.name === "computed_plot") {
      return {
        ...node.id ? { id: node.id } : {},
        kind: "plots",
        title: computedLabel(node, "Plot")
      };
    }
    if (node.name === "table") {
      const title = stringAttr2(node.attrs, "title") ?? stringAttr2(node.attrs, "caption");
      if (!title) return void 0;
      return {
        ...node.id ? { id: node.id } : {},
        kind: "tables",
        title
      };
    }
    return void 0;
  }
  function stringAttr2(attrs, key) {
    const value = attrs[key];
    return typeof value === "string" && value.trim() ? value.trim() : void 0;
  }
  function boolAttr(attrs, key) {
    const value = attrs[key];
    return value === true || value === "true" || value === "yes";
  }
  function directiveText(node) {
    if (node.body?.trim()) return node.body.trim();
    return node.children.map((child) => {
      if (child.type === "paragraph" || child.type === "quote" || child.type === "code") return child.content.trim();
      if (child.type === "list") return child.items.map((item) => item.content.trim()).join(" ");
      return "";
    }).filter(Boolean).join(" ");
  }
  function parseDatasetBody(node) {
    const body = node.body ?? "";
    if (!body.trim()) return null;
    const format = String(node.attrs.format ?? "").toLowerCase();
    if (format === "csv" || format === "tsv") {
      return parseDelimited(body, format === "tsv" ? "	" : ",");
    }
    if (format === "json") return parseJsonDataset(body, node);
    let parsed;
    try {
      parsed = jsYaml.load(body);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed;
    const schema2 = obj.schema;
    const rows = obj.rows;
    if (!Array.isArray(rows)) return null;
    let columns = [];
    if (schema2 && typeof schema2 === "object" && !Array.isArray(schema2)) {
      columns = Object.keys(schema2);
    } else if (typeof node.attrs.columns === "string") {
      columns = node.attrs.columns.split(/[,\s]+/).filter(Boolean);
    }
    const cleanRows = rows.filter((r) => Array.isArray(r)).map((r) => [...r]);
    return { columns, rows: cleanRows };
  }
  function parseDelimited(body, delim) {
    const lines = body.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const delimiter = delim === "	" ? "	" : ",";
    const split = (s) => splitDelimitedRow(s, delimiter);
    const columns = split(lines[0]);
    const rows = lines.slice(1).map((l) => {
      const cells = split(l);
      return cells.map((c) => {
        if (c === "") return null;
        const n = Number(c);
        return Number.isFinite(n) && /^-?\d/.test(c) ? n : c;
      });
    });
    return { columns, rows };
  }
  function parseJsonDataset(body, node) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return { columns: [], rows: [] };
      if (typeof parsed[0] === "object" && parsed[0] !== null && !Array.isArray(parsed[0])) {
        const columns = Object.keys(parsed[0]);
        const rows = parsed.map(
          (r) => columns.map((c) => r[c] ?? null)
        );
        return { columns, rows };
      }
      if (Array.isArray(parsed[0])) {
        let columns = [];
        if (typeof node.attrs.columns === "string") {
          columns = node.attrs.columns.split(/[,\s]+/).filter(Boolean);
        }
        return { columns, rows: parsed };
      }
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed;
      if (Array.isArray(obj.rows)) {
        const columns = Array.isArray(obj.columns) ? obj.columns : typeof node.attrs.columns === "string" ? node.attrs.columns.split(/[,\s]+/).filter(Boolean) : [];
        return { columns, rows: obj.rows };
      }
    }
    return null;
  }
  function resolvePlotData(table, column) {
    if (table.rows.length === 0) return null;
    let idx = -1;
    let name = column ?? "";
    if (column) {
      idx = table.columns.indexOf(column);
      if (idx === -1) return null;
    } else {
      for (let i = 0; i < table.columns.length; i++) {
        const sample = table.rows[0]?.[i];
        if (typeof sample === "number") {
          idx = i;
          name = table.columns[i] ?? `col${i}`;
          break;
        }
      }
      if (idx === -1) return null;
    }
    const values = table.rows.map((r) => Number(r[idx])).filter((n) => Number.isFinite(n));
    return values.length >= 2 ? { values, column: name } : null;
  }
  function resolvePlotLabels(table, column) {
    const idx = table.columns.indexOf(column);
    if (idx === -1) return null;
    return table.rows.map((r) => String(r[idx] ?? ""));
  }
  function renderHtml(doc, options = {}) {
    const allowExternalAssets = options.externalAssets !== false;
    const ctx = {
      allowEscapeHatches: options.allowEscapeHatches !== false,
      externalAssets: allowExternalAssets,
      interactive: options.interactive !== false,
      strictInteractiveBadgeEmitted: false,
      datasets: buildDatasetRegistry(doc),
      citations: collectCitationEntries(doc),
      sections: collectSectionEntries(doc),
      captions: collectCaptionEntries(doc),
      computed: buildComputedEvalContext(doc),
      sourcePositions: options.sourcePositions === true
    };
    const body = doc.children.map((c) => renderNode(c, ctx)).join("\n");
    if (!options.standalone) return body;
    const title = options.title || (typeof doc.meta.title === "string" ? doc.meta.title : void 0) || extractFirstHeading(doc) || "Noma Document";
    const themeCss = options.themeCss ?? "";
    const stylesheetHref = options.stylesheetHref;
    const styleHead = stylesheetHref ? `<link rel="stylesheet" href="${escapeAttr(stylesheetHref)}" />` : `<style>${themeCss}</style>`;
    const mathMode = allowExternalAssets ? resolveMathMode(doc, options.math) : "none";
    const mathHead = mathMode === "katex" ? KATEX_HEAD : "";
    const mathFoot = mathMode === "katex" ? KATEX_FOOT : "";
    const diagramKinds = resolveDiagramKinds(doc);
    const diagramFoot = allowExternalAssets ? diagramScripts(diagramKinds) : "";
    const computedFoot = ctx.interactive && usesComputedRuntime(doc) ? COMPUTED_RUNTIME_FOOT : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${escapeHtml(title)}</title>
${styleHead}${mathHead}
</head>
<body>
<main class="noma-doc">
${body}
</main>${mathFoot}${diagramFoot}${computedFoot}
</body>
</html>`;
  }
  var MERMAID_VERSION = "11.4.0";
  var VIZ_VERSION = "3.11.0";
  var DRAWIO_VIEWER = "https://viewer.diagrams.net/js/viewer-static.min.js";
  var PLOTLY_VERSION = "2.35.2";
  function resolveDiagramKinds(doc) {
    const kinds = /* @__PURE__ */ new Set();
    for (const node of walk(doc)) {
      if (node.type !== "directive") continue;
      if (node.name === "diagram") {
        const k = String(node.attrs.kind ?? "mermaid").toLowerCase();
        if (k) kinds.add(k);
      }
      if (node.name === "plotly") kinds.add("plotly");
    }
    return kinds;
  }
  function usesComputedRuntime(doc) {
    for (const node of walk(doc)) {
      if (node.type === "directive" && isComputedDirective(node)) return true;
    }
    return false;
  }
  function diagramScripts(kinds) {
    const out = [];
    if (kinds.has("mermaid")) {
      out.push(MERMAID_FOOT);
    }
    if (kinds.has("graphviz") || kinds.has("dot")) {
      out.push(VIZ_FOOT);
    }
    if (kinds.has("drawio")) {
      out.push(`<script src="${DRAWIO_VIEWER}"><\/script>`);
    }
    if (kinds.has("plotly")) {
      out.push(PLOTLY_FOOT);
    }
    return out.join("");
  }
  var MERMAID_FOOT = `
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
const els = document.querySelectorAll(".noma-diagram-mermaid");
for (let i = 0; i < els.length; i++) {
  const el = els[i];
  const src = el.getAttribute("data-noma-source");
  if (!src) continue;
  try {
    const out = await mermaid.render("noma-mermaid-" + i, src);
    el["inn" + "erHTML"] = out.svg;
  } catch (e) { el.textContent = String(e); }
}
<\/script>`;
  var VIZ_FOOT = `
<script type="module">
import("https://cdn.jsdelivr.net/npm/@viz-js/viz@${VIZ_VERSION}/lib/viz-standalone.mjs").then(({ instance }) => instance().then((viz) => {
  document.querySelectorAll(".noma-diagram-graphviz, .noma-diagram-dot").forEach((el) => {
    const src = el.getAttribute("data-noma-source");
    if (!src) return;
    try { el["inn" + "erHTML"] = viz.renderString(src, { format: "svg" }); }
    catch (e) { el.textContent = String(e); }
  });
}));
<\/script>`;
  var PLOTLY_FOOT = `
<script src="https://cdn.plot.ly/plotly-${PLOTLY_VERSION}.min.js" charset="utf-8"><\/script>
<script>
document.querySelectorAll(".noma-plotly").forEach((el) => {
  const src = el.getAttribute("data-noma-source");
  if (!src) return;
  try {
    const spec = JSON.parse(src);
    Plotly.newPlot(el, spec.data || [], spec.layout || {}, Object.assign({ responsive: true }, spec.config || {}));
  } catch (e) { el.textContent = String(e); }
});
<\/script>`;
  var COMPUTED_RUNTIME_FOOT = `
<script>
(() => {
  const computedEls = Array.from(document.querySelectorAll("[data-noma-computed]"));
  if (computedEls.length === 0) return;
  const controls = Array.from(document.querySelectorAll("[data-noma-control-input]"));
  const computedById = new Map(computedEls.filter((el) => el.id).map((el) => [el.id, el]));
  const astCache = new WeakMap();

  function readAst(el) {
    if (astCache.has(el)) return astCache.get(el);
    const raw = el.getAttribute("data-formula-ast");
    if (!raw) return null;
    try {
      const ast = JSON.parse(raw);
      astCache.set(el, ast);
      return ast;
    } catch {
      return null;
    }
  }

  function readControls() {
    const env = {};
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id) continue;
      const value = input.type === "checkbox" ? (input.checked ? 1 : 0) : Number(input.value);
      if (Number.isFinite(value)) env[id] = value;
    }
    return env;
  }

  function evaluateComputed(el, env, visiting) {
    if (el.id && Object.prototype.hasOwnProperty.call(env, el.id)) return env[el.id];
    if (el.id && visiting.has(el.id)) return undefined;
    if (el.id) visiting.add(el.id);
    const ast = readAst(el);
    if (!ast) {
      if (el.id) visiting.delete(el.id);
      return undefined;
    }
    const value = evaluateAst(ast, env, visiting);
    if (el.id) visiting.delete(el.id);
    if (!Number.isFinite(value)) return undefined;
    if (el.id) env[el.id] = value;
    return value;
  }

  function evaluateAst(ast, env, visiting) {
    switch (ast.type) {
      case "number":
        return ast.value;
      case "identifier":
        if (Object.prototype.hasOwnProperty.call(env, ast.name)) return env[ast.name];
        if (computedById.has(ast.name)) {
          const value = evaluateComputed(computedById.get(ast.name), env, visiting);
          return value === undefined ? NaN : value;
        }
        return NaN;
      case "unary": {
        const value = evaluateAst(ast.expr, env, visiting);
        return ast.op === "-" ? -value : value;
      }
      case "binary": {
        const left = evaluateAst(ast.left, env, visiting);
        const right = evaluateAst(ast.right, env, visiting);
        switch (ast.op) {
          case "+": return left + right;
          case "-": return left - right;
          case "*": return left * right;
          case "/": return right === 0 ? NaN : left / right;
          case "^": return Math.pow(left, right);
          case ">": return left > right ? 1 : 0;
          case ">=": return left >= right ? 1 : 0;
          case "<": return left < right ? 1 : 0;
          case "<=": return left <= right ? 1 : 0;
          case "==": return left === right ? 1 : 0;
          case "!=": return left !== right ? 1 : 0;
          default: return NaN;
        }
      }
      case "call": {
        const args = ast.args.map((arg) => evaluateAst(arg, env, visiting));
        if (args.some((value) => !Number.isFinite(value))) return NaN;
        switch (ast.name) {
          case "pow": return args.length === 2 ? Math.pow(args[0], args[1]) : NaN;
          case "min": return args.length >= 1 ? Math.min.apply(Math, args) : NaN;
          case "max": return args.length >= 1 ? Math.max.apply(Math, args) : NaN;
          case "clamp": return args.length === 3 ? Math.min(Math.max(args[0], args[1]), args[2]) : NaN;
          case "round": {
            if (args.length < 1 || args.length > 2) return NaN;
            const factor = Math.pow(10, Math.trunc(args[1] || 0));
            return Math.round(args[0] * factor) / factor;
          }
          case "abs": return args.length === 1 ? Math.abs(args[0]) : NaN;
          case "if": return args.length === 3 ? (args[0] !== 0 ? args[1] : args[2]) : NaN;
          default: return NaN;
        }
      }
      default:
        return NaN;
    }
  }

  function parseDomain(raw) {
    const match = /^\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\.\\.\\s*(-?\\d+(?:\\.\\d+)?)(?:\\s*:\\s*(-?\\d+(?:\\.\\d+)?))?\\s*$/.exec(raw || "");
    if (!match) return null;
    const variable = match[1];
    const start = Number(match[2]);
    const end = Number(match[3]);
    const explicitStep = match[4] === undefined ? undefined : Number(match[4]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const step = explicitStep === undefined ? (Number.isInteger(start) && Number.isInteger(end) ? (start <= end ? 1 : -1) : (end - start) / 10) : explicitStep;
    if (!Number.isFinite(step) || step === 0) return null;
    const points = [];
    const forward = step > 0;
    for (let value = start; forward ? value <= end + 1e-9 : value >= end - 1e-9; value += step) {
      points.push(Number(value.toFixed(10)));
      if (points.length >= 25) break;
    }
    return points.length ? { variable, points } : null;
  }

  function formatNumber(value) {
    if (Math.abs(value) >= 1000000) return value.toFixed(0);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(6).replace(/0+$/, "").replace(/\\.$/, "");
  }

  function formatDisplay(value, unit) {
    const text = formatNumber(value);
    if (!unit) return text;
    if (text.endsWith(unit)) return text;
    return /^[%\xB0]/.test(unit) ? text + unit : text + " " + unit;
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function axisNumber(value) {
    const abs = Math.abs(value);
    if (abs >= 1000000) return (value / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + "M";
    if (abs >= 1000) return (value / 1000).toFixed(abs >= 10000 ? 0 : 1) + "k";
    if (abs >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function placeholder(width, height) {
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polyline points="0,' + (height - 20) + ' ' + (width * 0.13) + ',' + (height - 40) + ' ' + (width * 0.25) + ',' + (height - 30) + ' ' + (width * 0.38) + ',' + (height - 60) + ' ' + (width * 0.5) + ',' + (height - 65) + ' ' + (width * 0.63) + ',' + (height - 80) + ' ' + (width * 0.75) + ',' + (height - 85) + ' ' + (width * 0.88) + ',' + (height - 100) + ' ' + width + ',' + (height - 105) + '" fill="none" stroke="currentColor" stroke-width="2" /></svg>';
  }

  function renderChart(values, type, width, height, labels) {
    if (!values || values.length < 2) return placeholder(width, height);
    const min = Math.min.apply(Math, values);
    const max = Math.max.apply(Math, values);
    const span = max - min || 1;
    const isBar = type === "bar";
    const padL = 28;
    const padR = isBar ? 12 : 6;
    const padT = 8;
    const padB = labels.length ? 36 : 8;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;
    const x = (index) => values.length === 1 ? padL + innerW / 2 : isBar ? padL + ((index + 0.5) / values.length) * innerW : padL + (index / (values.length - 1)) * innerW;
    const y = (value) => padT + innerH - ((value - min) / span) * innerH;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => '<line x1="' + padL + '" x2="' + (width - padR) + '" y1="' + (padT + t * innerH) + '" y2="' + (padT + t * innerH) + '" stroke="currentColor" stroke-opacity="0.12" />').join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
      const value = max - t * span;
      return '<text x="' + (padL - 4) + '" y="' + (padT + i * innerH * 0.25 + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="currentColor" opacity="0.7">' + escapeText(axisNumber(value)) + '</text>';
    }).join("");
    const plot = isBar
      ? values.map((value, index) => {
          const slot = innerW / values.length;
          const barW = slot * 0.68;
          const top = y(value);
          const left = x(index) - barW / 2;
          return '<rect x="' + left.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + (padT + innerH - top).toFixed(1) + '" fill="#2B5265" opacity="0.85" />';
        }).join("")
      : '<polyline points="' + values.map((value, index) => x(index).toFixed(1) + ',' + y(value).toFixed(1)).join(" ") + '" fill="none" stroke="#2B5265" stroke-width="2" />' +
        values.map((value, index) => '<circle cx="' + x(index).toFixed(1) + '" cy="' + y(value).toFixed(1) + '" r="2.5" fill="#2B5265" />').join("");
    const xLabels = labels.length
      ? labels.map((label, index) => {
          if (values.length > 8 && index % Math.ceil(values.length / 6) !== 0 && index !== values.length - 1) return "";
          const anchor = index === 0 ? "start" : index === values.length - 1 ? "end" : "middle";
          return '<text x="' + x(index).toFixed(1) + '" y="' + (padT + innerH + 14).toFixed(1) + '" text-anchor="' + anchor + '" font-size="9" fill="currentColor" opacity="0.7">' + escapeText(label) + '</text>';
        }).join("")
      : "";
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" role="img">' + grid + plot + ticks + xLabels + '</svg>';
  }

  function update() {
    const controlEnv = readControls();
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id) continue;
      const wrap = input.closest("[data-noma-control]");
      let output = null;
      if (wrap) {
        for (const candidate of wrap.querySelectorAll("[data-noma-control-value]")) {
          if (candidate.getAttribute("data-noma-control-value") === id) output = candidate;
        }
      }
      const value = input.type === "checkbox" ? (input.checked ? 1 : 0) : Number(input.value);
      if (output && Number.isFinite(value)) output.textContent = formatDisplay(value, wrap ? wrap.getAttribute("data-unit") : "");
    }
    for (const el of computedEls) {
      if (el.getAttribute("data-noma-computed") === "plot") {
        const domain = parseDomain(el.getAttribute("data-domain"));
        const canvas = el.querySelector("[data-noma-computed-plot]");
        if (!domain || !canvas) continue;
        const values = [];
        for (const point of domain.points) {
          const env = Object.assign({}, controlEnv);
          env[domain.variable] = point;
          const value = evaluateComputed(el, env, new Set());
          if (value === undefined) {
            values.length = 0;
            break;
          }
          values.push(value);
        }
        canvas["inn" + "erHTML"] = renderChart(values, el.getAttribute("data-chart-type") || "line", Number(el.getAttribute("data-width") || 320), Number(el.getAttribute("data-height") || 140), domain.points.map(formatNumber));
      } else if (el.getAttribute("data-noma-computed") === "table") {
        const domain = parseDomain(el.getAttribute("data-domain"));
        const body = el.querySelector("[data-noma-computed-table]");
        if (!domain || !body) continue;
        const rows = [];
        for (const point of domain.points) {
          const env = Object.assign({}, controlEnv);
          env[domain.variable] = point;
          const value = evaluateComputed(el, env, new Set());
          if (value === undefined) {
            rows.length = 0;
            break;
          }
          rows.push('<tr><td>' + escapeText(formatNumber(point)) + '</td><td>' + escapeText(formatDisplay(value, el.getAttribute("data-unit") || "")) + '</td></tr>');
        }
        body["inn" + "erHTML"] = rows.length ? rows.join("") : '<tr><td colspan="2">\u2014</td></tr>';
      } else {
        const env = Object.assign({}, controlEnv);
        const value = evaluateComputed(el, env, new Set());
        const target = el.querySelector("[data-noma-computed-value]");
        if (target) target.textContent = value === undefined ? "\u2014" : formatDisplay(value, el.getAttribute("data-unit") || "");
      }
    }
  }

  function readHashState() {
    const raw = window.location.hash ? window.location.hash.slice(1) : "";
    if (!raw || !raw.includes("=")) return {};
    const source = raw.startsWith("noma:") ? raw.slice(5) : raw;
    const params = new URLSearchParams(source);
    const state = {};
    for (const [key, value] of params.entries()) state[key] = value;
    return state;
  }

  function applyHashState() {
    const state = readHashState();
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id || !Object.prototype.hasOwnProperty.call(state, id)) continue;
      if (input.type === "checkbox") {
        const value = String(state[id]).toLowerCase();
        input.checked = value === "1" || value === "true" || value === "yes" || value === "on" || value === "checked";
      } else {
        input.value = state[id];
      }
    }
  }

  function writeHashState() {
    const params = new URLSearchParams();
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id) continue;
      params.set(id, input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value);
    }
    const hash = params.toString();
    if (hash) history.replaceState(null, "", window.location.pathname + window.location.search + "#noma:" + hash);
  }

  for (const input of controls) {
    input.addEventListener("input", () => { writeHashState(); update(); });
    input.addEventListener("change", () => { writeHashState(); update(); });
  }
  applyHashState();
  update();
})();
<\/script>`;
  var KATEX_VERSION = "0.16.11";
  var KATEX_HEAD = `
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css" crossorigin="anonymous" />`;
  var KATEX_FOOT = `
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js" crossorigin="anonymous"><\/script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/contrib/auto-render.min.js" crossorigin="anonymous" onload="renderMathInElement(document.body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '\\\\[', right: '\\\\]', display: true}, {left: '\\\\(', right: '\\\\)', display: false}, {left: '$', right: '$', display: false}], throwOnError: false});"><\/script>`;
  function resolveMathMode(doc, override) {
    if (override === "katex" || override === "none") return override;
    if (typeof doc.meta.math === "string") {
      return doc.meta.math === "katex" ? "katex" : "none";
    }
    if (doc.meta.math === true) return "katex";
    for (const node of walk(doc)) {
      if (node.type === "directive" && node.name === "math") return "katex";
      const text = textForMathScan(node);
      if (text && /\$\$[^$]+\$\$|\\\(|\\\[/.test(text)) return "katex";
    }
    return "none";
  }
  function textForMathScan(node) {
    if (node.type === "paragraph" || node.type === "quote") return node.content;
    if (node.type === "list_item") return node.content;
    if (node.type === "section") return node.title;
    if (node.type === "directive" && node.body) return node.body;
    if (node.type === "code") return null;
    return null;
  }
  function renderNode(node, ctx) {
    switch (node.type) {
      case "document":
        return node.children.map((c) => renderNode(c, ctx)).join("\n");
      case "section":
        return renderSection(node, ctx);
      case "paragraph":
        return `<p${sourceEditAttrs(node, ctx, "paragraph")}>${inlineToHtml(node.content)}</p>`;
      case "code": {
        const langClass = node.lang ? ` class="lang-${escapeAttr(node.lang)}"` : "";
        return `<pre><code${langClass}>${escapeHtml(node.content)}</code></pre>`;
      }
      case "list": {
        const tag = node.ordered ? "ol" : "ul";
        const items = node.items.map((item) => `  <li${sourceEditAttrs(item, ctx, "list_item")}>${inlineToHtml(item.content)}</li>`).join("\n");
        return `<${tag}>
${items}
</${tag}>`;
      }
      case "list_item":
        return `<li${sourceEditAttrs(node, ctx, "list_item")}>${inlineToHtml(node.content)}</li>`;
      case "quote":
        return `<blockquote${sourceEditAttrs(node, ctx, "quote")}>${inlineToHtml(node.content)}</blockquote>`;
      case "thematic_break":
        return `<hr />`;
      case "table": {
        const head = node.header.map((cell, idx) => {
          const align = node.align[idx];
          const styleAttr = align ? ` style="text-align: ${align}"` : "";
          return `<th${styleAttr}>${inlineToHtml(cell)}</th>`;
        }).join("");
        const body = node.rows.map((row) => {
          const cells = row.map((cell, idx) => {
            const align = node.align[idx];
            const styleAttr = align ? ` style="text-align: ${align}"` : "";
            return `<td${styleAttr}>${inlineToHtml(cell)}</td>`;
          }).join("");
          return `<tr>${cells}</tr>`;
        }).join("\n");
        return `<table class="noma-table">
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>`;
      }
      case "directive":
        return renderDirective(node, ctx);
      case "frontmatter":
        return "";
      default: {
        const _exhaustive = node;
        void _exhaustive;
        return "";
      }
    }
  }
  function renderSection(node, ctx) {
    const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
    const aliasAnchors = (node.aliases ?? []).map((a) => `<a class="noma-alias" id="${escapeAttr(a)}" aria-hidden="true"></a>`).join("");
    const heading = `<h${node.level}${sourceEditAttrs(node, ctx, "section", node.pos?.line)}>${inlineToHtml(node.title)}</h${node.level}>`;
    const inner = node.children.map((c) => renderNode(c, ctx)).join("\n");
    return `<section${idAttr} data-level="${node.level}">
${aliasAnchors}${heading}
${inner}
</section>`;
  }
  function sourceEditAttrs(node, ctx, kind, endLine = node.endLine) {
    if (!ctx.sourcePositions || !node.pos?.line) return "";
    const lastLine = endLine ?? node.pos.line;
    return ` data-noma-editable="${escapeAttr(kind)}" data-noma-line="${node.pos.line}" data-noma-end-line="${lastLine}"`;
  }
  function variantAttr(node) {
    const v = node.attrs.variant;
    return typeof v === "string" && v.length > 0 ? ` data-variant="${escapeAttr(v)}"` : "";
  }
  function gridLayoutAttrs(node, columns, baseClass = "noma-grid") {
    const classes = [baseClass];
    const width = String(node.attrs.width ?? node.attrs.span ?? "");
    const min = cssLength(
      node.attrs.min ?? node.attrs.min_width ?? node.attrs.minWidth ?? node.attrs.minColumnWidth ?? node.attrs["min-width"]
    );
    const gap = cssLength(node.attrs.gap);
    if (node.attrs.wide === true || width === "wide") classes.push(`${baseClass}-wide`);
    if (node.attrs.full === true || width === "full") classes.push(`${baseClass}-full`);
    if (node.attrs.compact === true || node.attrs.dense === true) classes.push(`${baseClass}-compact`);
    if (min) classes.push(`${baseClass}-auto`);
    const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.min(12, Math.floor(columns))) : 2;
    const vars = [`--noma-cols: ${safeColumns}`];
    if (min) vars.push(`--noma-grid-min: ${min}`);
    if (gap) vars.push(`--noma-grid-gap: ${gap}`);
    return {
      className: classes.map(escapeAttr).join(" "),
      style: escapeAttr(`${vars.join("; ")};`)
    };
  }
  function cssLength(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return `${value}px`;
    if (typeof value !== "string") return void 0;
    const trimmed = value.trim();
    if (trimmed === "0") return trimmed;
    return /^(?:\d+(?:\.\d+)?)(?:px|rem|em|ch|vw|%)$/.test(trimmed) ? trimmed : void 0;
  }
  function renderDirective(node, ctx) {
    const name = node.name;
    const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
    const variant = variantAttr(node);
    const dataAttrs = Object.entries(node.attrs).filter(([k]) => k !== "id").map(([k, v]) => ` data-${escapeAttr(k)}="${escapeAttr(String(v))}"`).join("");
    switch (name) {
      case "summary":
      case "abstract":
        return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node, ctx));
      case "callout":
      case "note":
      case "warning":
      case "tip": {
        const tone = name === "callout" ? String(node.attrs.tone ?? "info") : name;
        return `<aside class="noma-callout noma-callout-${escapeAttr(tone)}"${idAttr}${variant}>${renderChildren(node, ctx)}</aside>`;
      }
      case "claim":
      case "evidence":
      case "counterevidence":
      case "assumption":
      case "risk":
      case "hypothesis":
      case "result":
      case "limitation":
      case "open_question":
      case "decision":
      case "adr":
        return renderResearchBlock(node, ctx);
      case "export_button": {
        const format = node.attrs.format ? String(node.attrs.format) : "text";
        const target = node.attrs.target ? String(node.attrs.target) : "";
        const label = node.attrs.Label && String(node.attrs.Label) || node.attrs.label && String(node.attrs.label) || node.body?.trim() || `Copy as ${format}`;
        const cleanLabel = label.replace(/^Label:\s*/, "");
        return `<button type="button" class="noma-export-button" data-format="${escapeAttr(format)}" data-target="${escapeAttr(target)}"${idAttr}>${escapeHtml(cleanLabel)}</button>`;
      }
      case "control": {
        return renderControl(node, idAttr + dataAttrs, ctx);
      }
      case "grid": {
        const cols = Number(node.attrs.columns ?? 2);
        const layout = gridLayoutAttrs(node, cols);
        return `<div class="${layout.className}"${idAttr} style="${layout.style}"${dataAttrs}>${renderChildren(node, ctx)}</div>`;
      }
      case "card": {
        const title = node.attrs.title ? String(node.attrs.title) : void 0;
        const icon = node.attrs.icon ? String(node.attrs.icon) : void 0;
        const head = title ? `<header class="noma-card-head">${icon ? `<span class="noma-icon" aria-hidden="true">\u25C6</span>` : ""}<h3>${escapeHtml(title)}</h3></header>` : "";
        return `<article class="noma-card"${idAttr}${variant}>${head}<div class="noma-card-body">${renderChildren(node, ctx)}</div></article>`;
      }
      case "hero":
        return `<section class="noma-hero"${idAttr}>${renderChildren(node, ctx)}</section>`;
      case "page_setup":
        return renderPageSetup(node, idAttr + dataAttrs);
      case "header":
        return renderPageChrome("header", node, idAttr + dataAttrs, ctx);
      case "footer":
        return renderPageChrome("footer", node, idAttr + dataAttrs, ctx);
      case "toc":
        return renderToc(node, idAttr + dataAttrs, ctx);
      case "pagebreak":
        return `<div class="noma-pagebreak"${idAttr} role="separator" aria-label="Page break"></div>`;
      case "button": {
        const href = node.attrs.href ? String(node.attrs.href) : "#";
        return `<a class="noma-button" href="${escapeAttr(href)}"${idAttr}>${renderChildren(node, ctx) || escapeHtml(node.body ?? "")}</a>`;
      }
      case "figure": {
        const caption = node.attrs.caption ? String(node.attrs.caption) : void 0;
        const src = node.attrs.src ? String(node.attrs.src) : void 0;
        const alt = node.attrs.alt ? String(node.attrs.alt) : "";
        const img = src ? renderFigureImage(src, alt, ctx) : renderChildren(node, ctx);
        return `<figure${idAttr}>${img}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
      }
      case "plot":
        return renderPlotPlaceholder(node, idAttr, ctx);
      case "diagram":
        return renderDiagram(node, idAttr);
      case "plotly":
        return renderPlotly(node, idAttr);
      case "dataset": {
        const summary = `Dataset: ${escapeHtml(String(node.attrs.id ?? "dataset"))}`;
        const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
        const inline = node.body ?? "";
        const body = inline.trim() ? escapeHtml(inline) : src ? `<a class="noma-dataset-src" href="${escapeAttr(src)}">${escapeHtml(src)}</a>` : "";
        return `<details class="noma-dataset"${idAttr}${src ? ` data-src="${escapeAttr(src)}"` : ""}><summary>${summary}</summary><pre>${body}</pre></details>`;
      }
      case "metric":
        return renderMetric(node, idAttr + dataAttrs, ctx);
      case "computed_metric":
        return renderComputedMetric(node, idAttr + variant, ctx);
      case "computed_plot":
        return renderComputedPlot(node, idAttr + variant, ctx);
      case "computed_table":
        return renderComputedTable(node, idAttr + variant, ctx);
      case "code":
        return renderCodeDirective(node, idAttr + dataAttrs, ctx);
      case "code_cell":
        return renderCodeCell(node, idAttr + dataAttrs, ctx);
      case "output":
        return renderOutputBlock(node, idAttr + dataAttrs, ctx);
      case "memory_index":
        return renderMemoryIndex(node, idAttr + dataAttrs, ctx);
      case "memory":
        return renderMemory(node, idAttr + dataAttrs, ctx);
      case "agent_task":
      case "todo":
        return renderAgentTask(node, idAttr, ctx);
      case "comment":
        return renderComment(node, idAttr + dataAttrs, ctx);
      case "review":
      case "provenance":
      case "confidence":
        return renderReviewMetaBlock(node, idAttr + dataAttrs, ctx);
      case "api":
      case "endpoint":
      case "parameter":
      case "example":
      case "query":
      case "instruction":
      case "changelog":
        return renderTechnicalDirective(node, idAttr + dataAttrs, ctx);
      case "change_request":
        return renderChangeRequest(node, idAttr + dataAttrs, ctx);
      case "state_change":
        return renderStateChange(node, idAttr, ctx);
      case "table":
        return renderTableDirective(node, idAttr);
      case "math": {
        const body = (node.body ?? "").trim();
        const display = node.attrs.display !== "inline";
        const wrapped = display ? `\\[${body}\\]` : `\\(${body}\\)`;
        const cls = display ? "noma-math noma-math-display" : "noma-math noma-math-inline";
        return `<div class="${cls}"${idAttr}>${escapeHtml(wrapped)}</div>`;
      }
      case "tabs":
      case "accordion":
      case "sidebar":
        return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node, ctx));
      case "columns": {
        const cols = Number(node.attrs.columns ?? 2);
        const layout = gridLayoutAttrs(node, cols, "noma-columns");
        return `<div class="${layout.className}"${idAttr} style="${layout.style}"${dataAttrs}>${renderChildren(node, ctx)}</div>`;
      }
      case "citation":
        return `<cite class="noma-citation"${idAttr}>${renderChildren(node, ctx) || escapeHtml(node.body ?? "")}</cite>`;
      case "bibliography":
        return renderBibliography(node, idAttr + dataAttrs, ctx);
      case "footnote":
      case "endnote": {
        const label = node.attrs.label ? `<sup>${escapeHtml(String(node.attrs.label))}</sup>` : "";
        const cls = node.name === "endnote" ? "noma-endnote" : "noma-footnote";
        return `<aside class="${cls}"${idAttr}${dataAttrs}>${label}${renderChildren(node, ctx)}</aside>`;
      }
      case "html":
        return ctx.allowEscapeHatches ? `<div class="noma-raw-html"${idAttr}>${node.body ?? ""}</div>` : `<aside class="noma-blocked-escape" data-kind="html"${idAttr}>[raw HTML escape hatch disabled]</aside>`;
      case "svg":
        return ctx.allowEscapeHatches ? `<div class="noma-raw-svg"${idAttr}>${node.body ?? ""}</div>` : `<aside class="noma-blocked-escape" data-kind="svg"${idAttr}>[raw SVG escape hatch disabled]</aside>`;
      case "script": {
        if (!ctx.allowEscapeHatches) {
          return `<aside class="noma-blocked-escape" data-kind="script"${idAttr}>[script escape hatch disabled]</aside>`;
        }
        const runtime = String(node.attrs.runtime ?? "browser");
        if (runtime !== "browser") {
          return `<!-- noma:script runtime="${escapeAttr(runtime)}" omitted -->`;
        }
        return `<script${idAttr}>${node.body ?? ""}<\/script>`;
      }
      default:
        return renderGenericDirective(node, idAttr + dataAttrs, ctx);
    }
  }
  function renderGenericDirective(node, idAndAttrs, ctx) {
    const title = attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "caption");
    const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
    const meta = genericDirectiveMetaHtml(node.attrs);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-block noma-custom-directive noma-block-${escapeAttr(node.name)}"${idAndAttrs}>
  <header class="noma-block-head"><span class="noma-tag">${escapeHtml(readableDirectiveName(node.name))}</span>${titleHtml}</header>
  <div class="noma-block-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
  }
  function renderFigureImage(src, alt, ctx) {
    if (ctx.externalAssets || /^data:image\//i.test(src)) {
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
    }
    return `<aside class="noma-blocked-escape" data-kind="figure">[figure image asset disabled: ${escapeHtml(src)}]</aside>`;
  }
  function genericDirectiveMetaHtml(attrs) {
    const skip = /* @__PURE__ */ new Set(["id", "title", "caption", "variant"]);
    const fields = Object.entries(attrs).filter(([key]) => !skip.has(key)).map(([key, value]) => genericDirectiveMetaField(key, value));
    return metaFieldsHtml(fields);
  }
  function genericDirectiveMetaField(key, value) {
    const label = readableAttributeName(key);
    if (value === true) return `<span><span class="noma-meta-key">${escapeHtml(label)}</span></span>`;
    return `<span><span class="noma-meta-key">${escapeHtml(label)}</span> ${genericDirectiveValueHtml(value)}</span>`;
  }
  function genericDirectiveValueHtml(value) {
    const text = String(value);
    if (/^https?:\/\//.test(text)) return `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
    return escapeHtml(text);
  }
  function readableDirectiveName(name) {
    const words = splitIdentifierWords(name);
    if (words.length === 0) return "Directive";
    return words.map((word, index) => index === 0 ? titleWord(word) : word.toLowerCase()).join(" ");
  }
  function readableAttributeName(name) {
    return splitIdentifierWords(name).join(" ") || name;
  }
  function splitIdentifierWords(value) {
    return value.split(/::|[:_-]+/).map((part) => part.trim()).filter(Boolean);
  }
  function titleWord(word) {
    if (word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  function renderResearchBlock(node, ctx) {
    const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
    const variant = variantAttr(node);
    const confidence = typeof node.attrs.confidence === "number" ? node.attrs.confidence : void 0;
    const meta = researchMetaHtml(node);
    const confidenceBar = confidence !== void 0 ? `<div class="noma-confidence" title="confidence ${confidence}"><div class="noma-confidence-bar" style="width: ${Math.round(confidence * 100)}%"></div></div>` : "";
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-research noma-${escapeAttr(node.name)}"${idAttr}${variant}>
  <header class="noma-research-head"><span class="noma-tag">${escapeHtml(node.name)}</span>${confidenceBar}</header>
  <div class="noma-research-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
  }
  function researchMetaHtml(node) {
    switch (node.name) {
      case "evidence":
      case "counterevidence":
        return metaFieldsHtml([
          metaReferenceField("for", attrValueText(node.attrs, "for")),
          metaReferenceField("source", attrValueText(node.attrs, "source")),
          metaReferenceField("url", attrValueText(node.attrs, "url") ?? attrValueText(node.attrs, "href")),
          metaDoiField(attrValueText(node.attrs, "doi")),
          metaTextField("accessed", attrValueText(node.attrs, "accessed"))
        ]);
      case "risk":
        return metaFieldsHtml([
          metaTextField("severity", attrValueText(node.attrs, "severity")),
          metaTextField("owner", attrValueText(node.attrs, "owner")),
          metaTextField("status", attrValueText(node.attrs, "status"))
        ]);
      case "decision":
      case "adr":
        return metaFieldsHtml([
          metaTextField("status", attrValueText(node.attrs, "status")),
          metaTextField("owner", attrValueText(node.attrs, "owner")),
          metaTextField("date", attrValueText(node.attrs, "date") ?? attrValueText(node.attrs, "decided_at") ?? attrValueText(node.attrs, "decidedAt"))
        ]);
      case "open_question":
        return metaFieldsHtml([
          metaTextField("status", attrValueText(node.attrs, "status")),
          metaTextField("owner", attrValueText(node.attrs, "owner")),
          metaTextField("due", attrValueText(node.attrs, "due") ?? attrValueText(node.attrs, "due_at") ?? attrValueText(node.attrs, "dueAt"))
        ]);
      case "assumption":
      case "hypothesis":
      case "result":
      case "limitation":
        return metaFieldsHtml([
          metaTextField("status", attrValueText(node.attrs, "status")),
          metaTextField("owner", attrValueText(node.attrs, "owner")),
          metaTextField("confidence", attrValueText(node.attrs, "confidence")),
          metaReferenceField("source", attrValueText(node.attrs, "source"))
        ]);
      default:
        return metaFieldsHtml([
          metaReferenceField("for", attrValueText(node.attrs, "for")),
          metaReferenceField("source", attrValueText(node.attrs, "source")),
          metaTextField("severity", attrValueText(node.attrs, "severity"))
        ]);
    }
  }
  function renderChangeRequest(node, idAndAttrs, ctx) {
    const revision = changeRequestRevision(node);
    const target = stringAttr2(node.attrs, "target") ?? stringAttr2(node.attrs, "for") ?? stringAttr2(node.attrs, "parent") ?? stringAttr2(node.attrs, "block");
    const title = revision ? `change_request \xB7 ${revision.action}${target ? ` ${target}` : ""}` : "change_request";
    const delta = revision ? `<div class="noma-change-request-delta">${changeRequestDeltaHtml(revision)}</div>` : "";
    const body = revision?.usedBodyAsRevisionText ? "" : renderChildren(node, ctx);
    return `<aside class="noma-change-request"${idAndAttrs}>
  <header class="noma-change-request-head"><span class="noma-tag">${escapeHtml(title)}</span></header>
  ${delta}
  ${body}
</aside>`;
  }
  function changeRequestRevision(node) {
    const rawAction = (stringAttr2(node.attrs, "action") ?? stringAttr2(node.attrs, "type"))?.toLowerCase();
    if (rawAction !== "insert" && rawAction !== "delete" && rawAction !== "replace") return null;
    const body = directiveText(node);
    const text = stringAttr2(node.attrs, "text");
    const from = stringAttr2(node.attrs, "from") ?? (rawAction === "delete" ? text : void 0);
    const to = stringAttr2(node.attrs, "to") ?? (rawAction === "insert" ? text : void 0);
    if (rawAction === "replace") {
      if (!from || !to) return null;
      return { action: "replace", oldText: from, newText: to, usedBodyAsRevisionText: false };
    }
    if (rawAction === "insert") {
      const newText = to ?? body;
      if (!newText) return null;
      return { action: "insert", newText, usedBodyAsRevisionText: !to && !text };
    }
    const oldText = from ?? body;
    if (!oldText) return null;
    return { action: "delete", oldText, usedBodyAsRevisionText: !from && !text };
  }
  function changeRequestDeltaHtml(revision) {
    if (revision.action === "replace") {
      return `<del>${escapeHtml(revision.oldText ?? "")}</del> <ins>${escapeHtml(revision.newText ?? "")}</ins>`;
    }
    if (revision.action === "delete") return `<del>${escapeHtml(revision.oldText ?? "")}</del>`;
    return `<ins>${escapeHtml(revision.newText ?? "")}</ins>`;
  }
  function renderPageSetup(node, idAndAttrs) {
    const declarations = [];
    const size = cssPageSize(node.attrs);
    if (size) declarations.push(`size: ${size};`);
    const margin = cssLengthAttr(node.attrs, "margin");
    if (margin) declarations.push(`margin: ${margin};`);
    for (const [attr, prop] of [
      ["margin_top", "margin-top"],
      ["margin_right", "margin-right"],
      ["margin_bottom", "margin-bottom"],
      ["margin_left", "margin-left"]
    ]) {
      const value = cssLengthAttr(node.attrs, attr);
      if (value) declarations.push(`${prop}: ${value};`);
    }
    return `<style class="noma-page-setup"${idAndAttrs}>@page { ${declarations.join(" ")} }</style>`;
  }
  function renderPageChrome(tag, node, idAndAttrs, ctx) {
    const pageNumbers = boolAttr(node.attrs, "page_numbers") || boolAttr(node.attrs, "page_number");
    const totalPages = boolAttr(node.attrs, "total_pages") || boolAttr(node.attrs, "page_count");
    const body = renderChildren(node, ctx);
    const page = pageNumbers ? `<span class="noma-page-number">Page <span class="noma-page-current">1</span>${totalPages ? ' of <span class="noma-page-total">1</span>' : ""}</span>` : "";
    return `<${tag} class="noma-page-${tag}"${idAndAttrs}>${body}${page}</${tag}>`;
  }
  function renderToc(node, idAndAttrs, ctx) {
    const kind = tocKind(node);
    const title = stringAttr2(node.attrs, "title") ?? tocTitle(kind);
    if (kind !== "sections") {
      const entries2 = ctx.captions.filter((entry) => entry.kind === kind).map((entry) => {
        const label = `${captionEntryDisplayKind(entry.kind)}: ${entry.title}`;
        const content = entry.id ? `<a href="#${escapeAttr(entry.id)}">${escapeHtml(label)}</a>` : escapeHtml(label);
        return `<li data-kind="${entry.kind}">${content}</li>`;
      }).join("\n");
      return `<nav class="noma-toc noma-toc-${kind}"${idAndAttrs} aria-label="${escapeAttr(title)}">
  <h2>${escapeHtml(title)}</h2>
  <ol>
${entries2 || `<li>No ${kind} found.</li>`}
  </ol>
</nav>`;
    }
    const maxLevel = readPositiveInteger(node.attrs.depth) ?? readPositiveInteger(node.attrs.levels) ?? 3;
    const entries = ctx.sections.filter((entry) => entry.level <= maxLevel).map((entry) => {
      const titleHtml = escapeHtml(entry.title);
      const content = entry.id ? `<a href="#${escapeAttr(entry.id)}">${titleHtml}</a>` : titleHtml;
      return `<li data-level="${entry.level}">${content}</li>`;
    }).join("\n");
    return `<nav class="noma-toc"${idAndAttrs} aria-label="${escapeAttr(title)}">
  <h2>${escapeHtml(title)}</h2>
  <ol>
${entries || "<li>No sections found.</li>"}
  </ol>
</nav>`;
  }
  function tocKind(node) {
    const raw = (stringAttr2(node.attrs, "of") ?? stringAttr2(node.attrs, "kind") ?? stringAttr2(node.attrs, "type") ?? "sections").toLowerCase();
    if (raw === "figure" || raw === "figures") return "figures";
    if (raw === "table" || raw === "tables") return "tables";
    if (raw === "plot" || raw === "plots" || raw === "charts") return "plots";
    return "sections";
  }
  function tocTitle(kind) {
    if (kind === "figures") return "List of Figures";
    if (kind === "tables") return "List of Tables";
    if (kind === "plots") return "List of Plots";
    return "Contents";
  }
  function captionEntryDisplayKind(kind) {
    if (kind === "figures") return "Figure";
    if (kind === "tables") return "Table";
    return "Plot";
  }
  function renderBibliography(node, idAndAttrs, ctx) {
    const title = stringAttr2(node.attrs, "title") ?? "Bibliography";
    const intro = node.children.length > 0 ? renderChildren(node, ctx) : node.body?.trim() ? `<p>${inlineToHtml(node.body)}</p>` : "";
    const items = ctx.citations.length > 0 ? ctx.citations.map((entry) => `<li>${renderCitationEntry(entry)}</li>`).join("\n") : "<li>No citations found.</li>";
    return `<section class="noma-bibliography"${idAndAttrs}>
  <h2>${escapeHtml(title)}</h2>
  ${intro}
  <ol>
${items}
  </ol>
</section>`;
  }
  function renderCitationEntry(entry) {
    const links = [];
    if (entry.url) links.push(`<a href="${escapeAttr(entry.url)}">URL</a>`);
    if (entry.doi) links.push(`<a href="https://doi.org/${escapeAttr(entry.doi)}">DOI: ${escapeHtml(entry.doi)}</a>`);
    if (entry.accessed) links.push(`<span>Accessed: ${escapeHtml(entry.accessed)}</span>`);
    const meta = links.length > 0 ? ` <span class="noma-citation-meta">${links.join(" \xB7 ")}</span>` : "";
    return `${escapeHtml(citationEntryText(entry))}${meta}`;
  }
  function citationEntryText(entry) {
    const primary = entry.source ?? entry.title ?? entry.doi ?? entry.url ?? entry.id ?? "Untitled source";
    const body = entry.body?.replace(/\s+/g, " ").trim();
    return body && body !== primary ? `${primary} - ${body}` : primary;
  }
  function readPositiveInteger(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) return void 0;
    return parsed;
  }
  function cssPageSize(attrs) {
    const size = (stringAttr2(attrs, "size") ?? stringAttr2(attrs, "page_size"))?.toLowerCase();
    const orientation = stringAttr2(attrs, "orientation") === "landscape" ? " landscape" : "";
    if (size === "a4" || size === "letter" || size === "legal") return `${size}${orientation}`;
    const width = cssLengthAttr(attrs, "width");
    const height = cssLengthAttr(attrs, "height");
    if (width && height) return `${width} ${height}${orientation}`;
    return orientation.trim() || void 0;
  }
  function cssLengthAttr(attrs, key) {
    const value = attrs[key];
    if (typeof value === "number") return `${value}in`;
    if (typeof value !== "string") return void 0;
    const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(in|mm|cm|pt|px)?\s*$/i.exec(value);
    if (!match) return void 0;
    return `${match[1]}${match[2] ?? "in"}`;
  }
  function parseAlignSpec(raw, columns) {
    const codes = raw.split(/[,\s]+/).map((c) => c.trim().toLowerCase());
    const out = [];
    for (let i = 0; i < columns; i++) {
      const c = codes[i] ?? "-";
      if (c === "l" || c === "left") out.push("left");
      else if (c === "c" || c === "center") out.push("center");
      else if (c === "r" || c === "right") out.push("right");
      else out.push(null);
    }
    return out;
  }
  var splitTableLine = splitPipeRow;
  function renderTableDirective(node, idAttr) {
    const body = node.body ?? "";
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return `<div class="noma-block noma-block-table"${idAttr}></div>`;
    const rows = lines.map(splitTableLine);
    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (const r of rows) while (r.length < columns) r.push("");
    const wantsHeader = node.attrs.header === true || node.attrs.header === "true";
    const headerRow = wantsHeader ? rows.shift() : void 0;
    const align = typeof node.attrs.align === "string" ? parseAlignSpec(node.attrs.align, columns) : new Array(columns).fill(null);
    const renderCell = (tag, cell, idx) => {
      const a = align[idx];
      const styleAttr = a ? ` style="text-align: ${a}"` : "";
      return `<${tag}${styleAttr}>${inlineToHtml(cell)}</${tag}>`;
    };
    const head = headerRow ? `<thead><tr>${headerRow.map((c, i) => renderCell("th", c, i)).join("")}</tr></thead>
` : "";
    const bodyRows = rows.map((r) => `<tr>${r.map((c, i) => renderCell("td", c, i)).join("")}</tr>`).join("\n");
    return `<table class="noma-table"${idAttr}>
${head}<tbody>
${bodyRows}
</tbody>
</table>`;
  }
  function renderStateChange(node, idAttr, ctx) {
    const block = node.attrs.block ? String(node.attrs.block) : void 0;
    const attribute = node.attrs.attribute ? String(node.attrs.attribute) : void 0;
    const from = node.attrs.from !== void 0 ? String(node.attrs.from) : void 0;
    const to = node.attrs.to !== void 0 ? String(node.attrs.to) : void 0;
    const reason = node.attrs.reason ? String(node.attrs.reason) : void 0;
    const at = node.attrs.at ? String(node.attrs.at) : void 0;
    const target = block ? `<a class="noma-ref" href="#${escapeAttr(block)}">${escapeHtml(block)}</a>` : "\u2014";
    const attrLabel = attribute ? `<code>${escapeHtml(attribute)}</code>` : "";
    const fromTo = from !== void 0 && to !== void 0 ? `<span class="noma-state-from">${escapeHtml(from)}</span> <span class="noma-state-arrow" aria-hidden="true">\u2192</span> <span class="noma-state-to">${escapeHtml(to)}</span>` : "";
    const meta = [];
    if (at) meta.push(`<span class="noma-meta-key">at</span> ${escapeHtml(at)}`);
    if (reason) meta.push(`<span class="noma-meta-key">why</span> ${escapeHtml(reason)}`);
    const metaHtml = meta.length ? `<div class="noma-meta">${meta.join(" \xB7 ")}</div>` : "";
    const body = renderChildren(node, ctx);
    return `<aside class="noma-state-change"${idAttr}>
  <header class="noma-state-change-head"><span class="noma-tag">state_change</span> ${target}${attribute ? ` \xB7 ${attrLabel}` : ""}</header>
  ${fromTo ? `<div class="noma-state-change-delta">${fromTo}</div>` : ""}
  ${body}
  ${metaHtml}
</aside>`;
  }
  function renderAgentTask(node, idAttr, ctx) {
    const checked = node.attrs.done === true ? " checked" : "";
    return `<div class="noma-agent-task"${idAttr}>
  <label><input type="checkbox" disabled${checked} /> <span class="noma-tag">${escapeHtml(node.name)}</span></label>
  <div class="noma-agent-body">${renderChildren(node, ctx)}</div>
</div>`;
  }
  function renderComment(node, idAndAttrs, ctx) {
    const target = commentTarget(node);
    const targetHtml = target ? ` <a href="#${escapeAttr(target)}">${escapeHtml(target)}</a>` : "";
    const meta = metaFieldsHtml([
      metaReferenceField("target", target),
      metaTextField("author", attrValueText(node.attrs, "author")),
      metaTextField("date", attrValueText(node.attrs, "date") ?? attrValueText(node.attrs, "at")),
      metaTextField("status", attrValueText(node.attrs, "status")),
      metaTextField("resolved by", attrValueText(node.attrs, "resolved_by")),
      metaTextField("resolved at", attrValueText(node.attrs, "resolved_at"))
    ]);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-comment"${idAndAttrs}>
  <header class="noma-comment-head"><span class="noma-tag">Comment</span>${targetHtml}</header>
  <div class="noma-comment-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
  }
  function commentTarget(node) {
    return attrValueText(node.attrs, "for") ?? attrValueText(node.attrs, "parent") ?? attrValueText(node.attrs, "target") ?? attrValueText(node.attrs, "block") ?? attrValueText(node.attrs, "ref");
  }
  function renderReviewMetaBlock(node, idAndAttrs, ctx) {
    const title = reviewMetaTitle(node);
    const target = reviewTarget(node);
    const targetHtml = target ? ` <a href="#${escapeAttr(target)}">${escapeHtml(target)}</a>` : "";
    const meta = reviewMetaHtml(node);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-review-meta noma-collab-${escapeAttr(node.name)}"${idAndAttrs}>
  <header class="noma-review-meta-head"><span class="noma-tag">${escapeHtml(title)}</span>${targetHtml}</header>
  <div class="noma-review-meta-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
  }
  function reviewMetaTitle(node) {
    if (node.name === "review") return "Review";
    if (node.name === "provenance") return "Provenance";
    return "Confidence";
  }
  function reviewTarget(node) {
    return attrValueText(node.attrs, "for") ?? attrValueText(node.attrs, "target") ?? attrValueText(node.attrs, "block") ?? attrValueText(node.attrs, "claim");
  }
  function reviewMetaHtml(node) {
    switch (node.name) {
      case "review":
        return metaFieldsHtml([
          metaTextField("status", attrValueText(node.attrs, "status")),
          metaTextField("reviewer", attrValueText(node.attrs, "reviewer") ?? attrValueText(node.attrs, "author") ?? attrValueText(node.attrs, "by")),
          metaTextField("due", attrValueText(node.attrs, "due") ?? attrValueText(node.attrs, "due_at")),
          metaTextField("date", attrValueText(node.attrs, "date") ?? attrValueText(node.attrs, "at"))
        ]);
      case "provenance":
        return metaFieldsHtml([
          metaReferenceField("source", attrValueText(node.attrs, "source")),
          metaReferenceField("url", attrValueText(node.attrs, "url") ?? attrValueText(node.attrs, "href")),
          metaTextField("tool", attrValueText(node.attrs, "tool") ?? attrValueText(node.attrs, "agent")),
          metaTextField("by", attrValueText(node.attrs, "by") ?? attrValueText(node.attrs, "author")),
          metaTextField("commit", attrValueText(node.attrs, "commit") ?? attrValueText(node.attrs, "sha")),
          metaTextField("at", attrValueText(node.attrs, "at") ?? attrValueText(node.attrs, "date"))
        ]);
      case "confidence":
        return metaFieldsHtml([
          metaTextField("value", attrValueText(node.attrs, "value") ?? attrValueText(node.attrs, "score") ?? attrValueText(node.attrs, "confidence")),
          metaTextField("basis", attrValueText(node.attrs, "basis") ?? attrValueText(node.attrs, "reason")),
          metaReferenceField("source", attrValueText(node.attrs, "source")),
          metaTextField("updated", attrValueText(node.attrs, "updated") ?? attrValueText(node.attrs, "at") ?? attrValueText(node.attrs, "date"))
        ]);
      default:
        return "";
    }
  }
  function renderMemoryIndex(node, idAndAttrs, ctx) {
    return `<aside class="noma-memory-index"${idAndAttrs}>
  <header class="noma-memory-head"><span class="noma-tag">Memory index</span></header>
  <div class="noma-memory-body">${renderChildren(node, ctx)}</div>
</aside>`;
  }
  function renderMemory(node, idAndAttrs, ctx) {
    const kind = memoryTypeKind(node);
    const title = memoryDisplayTitle(node);
    const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
    const meta = memoryMetaHtml(node);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-memory noma-memory-${escapeAttr(kind)}"${idAndAttrs}>
  <header class="noma-memory-head"><span class="noma-tag">${escapeHtml(memoryTypeLabel(kind))}</span>${titleHtml}</header>
  <div class="noma-memory-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
  }
  function memoryDisplayTitle(node) {
    return attrValueText(node.attrs, "title") ?? node.id;
  }
  function memoryTypeKind(node) {
    const type2 = attrValueText(node.attrs, "type")?.toLowerCase();
    switch (type2) {
      case "user":
      case "feedback":
      case "project":
      case "reference":
        return type2;
      default:
        return "unknown";
    }
  }
  function memoryTypeLabel(kind) {
    switch (kind) {
      case "user":
        return "User memory";
      case "feedback":
        return "Feedback memory";
      case "project":
        return "Project memory";
      case "reference":
        return "Reference memory";
      default:
        return "Memory";
    }
  }
  function memoryMetaHtml(node) {
    return metaFieldsHtml([
      metaTextField("type", attrValueText(node.attrs, "type")),
      metaTextField("confidence", attrValueText(node.attrs, "confidence")),
      metaTextField("last seen", attrValueText(node.attrs, "last_seen") ?? attrValueText(node.attrs, "lastSeen")),
      metaTextField("scope", attrValueText(node.attrs, "scope")),
      metaReferenceField("source", attrValueText(node.attrs, "source")),
      metaTextField("valid until", attrValueText(node.attrs, "valid_until") ?? attrValueText(node.attrs, "validUntil")),
      metaReferenceField("superseded by", attrValueText(node.attrs, "superseded_by") ?? attrValueText(node.attrs, "supersededBy")),
      boolAttr(node.attrs, "expired") ? metaTextField("expired", "true") : void 0
    ]);
  }
  function renderControl(node, idAndAttrs, ctx) {
    const controlId = node.id ?? "";
    const rawType = (attrValueText(node.attrs, "type") ?? "number").toLowerCase();
    const min = attrValueText(node.attrs, "min");
    const max = attrValueText(node.attrs, "max");
    const step = attrValueText(node.attrs, "step");
    const value = controlDefaultText(node) ?? "";
    const unit = controlUnit(node);
    const controlData = controlId ? ` data-noma-control="${escapeAttr(controlId)}"` : "";
    const unitData = unit ? ` data-unit="${escapeAttr(unit)}"` : "";
    const input = rawType === "select" ? controlSelectHtml(node, controlId, value, ctx.interactive) : controlInputHtml(rawType, controlId, value, min, max, step, ctx.interactive);
    const output = controlId ? `<output class="noma-control-value" data-noma-control-value="${escapeAttr(controlId)}">${escapeHtml(formatControlValue(controlOutputValue(rawType, value), unit))}</output>` : "";
    return `<div class="noma-control"${idAndAttrs}${controlData}${unitData}>
  ${strictInteractiveBadge(ctx)}
  <label class="noma-control-row"><span class="noma-control-label">${escapeHtml(controlLabel(node))}</span>${input}</label>
  ${output}
</div>`;
  }
  function controlInputHtml(rawType, controlId, value, min, max, step, interactive) {
    const inputType = rawType === "slider" ? "range" : rawType === "toggle" ? "checkbox" : rawType;
    const checked = (inputType === "checkbox" || inputType === "toggle") && controlDefaultChecked(value);
    const inputAttrs = [
      `type="${escapeAttr(inputType)}"`,
      controlId ? `name="${escapeAttr(controlId)}"` : void 0,
      controlId ? `data-noma-control-input="${escapeAttr(controlId)}"` : void 0,
      min !== void 0 ? `min="${escapeAttr(min)}"` : void 0,
      max !== void 0 ? `max="${escapeAttr(max)}"` : void 0,
      step !== void 0 ? `step="${escapeAttr(step)}"` : void 0,
      inputType === "checkbox" ? `value="1"` : value !== "" ? `value="${escapeAttr(value)}"` : void 0,
      checked ? "checked" : void 0,
      interactive ? void 0 : "disabled"
    ].filter((attr) => Boolean(attr)).join(" ");
    return `<input ${inputAttrs} />`;
  }
  function controlSelectHtml(node, controlId, value, interactive) {
    const options = controlOptionsWithDefault(node, value);
    const attrs = [
      controlId ? `name="${escapeAttr(controlId)}"` : void 0,
      controlId ? `data-noma-control-input="${escapeAttr(controlId)}"` : void 0,
      interactive ? void 0 : "disabled"
    ].filter((attr) => Boolean(attr)).join(" ");
    const optionHtml = options.map((option) => `<option value="${escapeAttr(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
    return `<select${attrs ? ` ${attrs}` : ""}>${optionHtml}</select>`;
  }
  function controlOptionsWithDefault(node, value) {
    const options = controlOptions(node);
    if (!value || options.some((option) => option.value === value)) return options;
    return [{ value, label: value }, ...options];
  }
  function controlOutputValue(rawType, value) {
    return rawType === "checkbox" || rawType === "toggle" ? controlDefaultChecked(value) ? "1" : "0" : value;
  }
  function controlDefaultChecked(value) {
    const normalized = value.toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "checked";
  }
  function renderComputedMetric(node, idAndAttrs, ctx) {
    const label = computedLabel(node, "Computed metric");
    const unit = controlUnit(node);
    const formula = formulaText(node);
    const value = evaluateComputedNode(node, ctx.computed);
    const valueText = value !== void 0 ? computedValueText(value, unit) : "\u2014";
    const body = computedBodyHtml(node, ctx);
    const meta = computedMetaHtml(node, formula);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-computed noma-computed-metric"${idAndAttrs} data-noma-computed="metric"${unit ? ` data-unit="${escapeAttr(unit)}"` : ""}${computedDataAttrs(node)}>
  ${strictInteractiveBadge(ctx)}
  <header class="noma-computed-head"><span class="noma-tag">Computed metric</span><h3>${escapeHtml(label)}</h3></header>
  <div class="noma-computed-value" data-noma-computed-value>${escapeHtml(valueText)}</div>
  ${body}
  ${metaHtml}
</aside>`;
  }
  function renderComputedPlot(node, idAndAttrs, ctx) {
    const title = computedLabel(node, "Computed plot");
    const type2 = attrValueText(node.attrs, "type") ?? "line";
    const width = Number(node.attrs.width ?? 320);
    const compact = attrBool(node.attrs.compact);
    const height = Number(node.attrs.height ?? (compact ? 112 : 140));
    const series = evaluateComputedSeries(node, ctx.computed);
    const labelOptions = plotLabelOptionsFromAttrs(node.attrs, compact);
    const labels = series ? series.points.map(formatComputedNumber) : [];
    const svg = series ? renderChartSvg([{ name: title, values: series.values }], type2, width, height, labels, labelOptions) : placeholderPlotSvg(width, height);
    const formula = formulaText(node);
    const domain = computedDomainText(node);
    const captionParts = [
      escapeHtml(title),
      `<span class="noma-meta-key">type</span> ${escapeHtml(type2)}`,
      domain ? `<span class="noma-meta-key">domain</span> ${escapeHtml(domain)}` : void 0
    ].filter((part) => Boolean(part));
    const body = computedBodyHtml(node, ctx);
    const meta = computedMetaHtml(node, formula);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<figure class="noma-computed noma-computed-plot noma-plot"${idAndAttrs} data-noma-computed="plot" data-chart-type="${escapeAttr(type2)}" data-width="${escapeAttr(String(width))}" data-height="${escapeAttr(String(height))}"${domain ? ` data-domain="${escapeAttr(domain)}"` : ""}${computedDataAttrs(node)}>
  ${strictInteractiveBadge(ctx)}
  <div class="noma-plot-canvas noma-computed-canvas" data-noma-computed-plot>
    ${svg}
  </div>
  <figcaption>${captionParts.join(" \xB7 ")}</figcaption>
  ${body}
  ${metaHtml}
</figure>`;
  }
  function renderComputedTable(node, idAndAttrs, ctx) {
    const title = computedLabel(node, "Computed table");
    const unit = controlUnit(node);
    const formula = formulaText(node);
    const domain = computedDomainText(node);
    const series = evaluateComputedSeries(node, ctx.computed);
    const variable = series?.variable ?? parseComputedTableVariable(domain) ?? "input";
    const [variableLabel, valueLabel] = computedTableHeaders(node, variable);
    const rows = series ? series.points.map((point, index) => {
      const rawValue = series.values[index];
      const value = rawValue !== void 0 ? computedValueText(rawValue, unit) : "\u2014";
      return `<tr><td>${escapeHtml(formatComputedNumber(point))}</td><td>${escapeHtml(value)}</td></tr>`;
    }).join("") : `<tr><td colspan="2">\u2014</td></tr>`;
    const body = computedBodyHtml(node, ctx);
    const meta = computedMetaHtml(node, formula);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-computed noma-computed-table"${idAndAttrs} data-noma-computed="table"${domain ? ` data-domain="${escapeAttr(domain)}"` : ""}${unit ? ` data-unit="${escapeAttr(unit)}"` : ""}${computedDataAttrs(node)}>
  ${strictInteractiveBadge(ctx)}
  <header class="noma-computed-head"><span class="noma-tag">Computed table</span><h3>${escapeHtml(title)}</h3></header>
  <table class="noma-table noma-computed-table-view">
    <thead><tr><th>${escapeHtml(variableLabel)}</th><th>${escapeHtml(valueLabel)}</th></tr></thead>
    <tbody data-noma-computed-table>${rows}</tbody>
  </table>
  ${body}
  ${metaHtml}
</aside>`;
  }
  function strictInteractiveBadge(ctx) {
    if (ctx.interactive || ctx.strictInteractiveBadgeEmitted) return "";
    ctx.strictInteractiveBadgeEmitted = true;
    return `<span class="noma-interactive-disabled">interactive controls disabled in strict mode</span>`;
  }
  function controlLabel(node) {
    return attrValueText(node.attrs, "label") ?? attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "name") ?? bodyFieldText(node, "label") ?? freeformBodyText(node, ["label", "unit", "default", "min", "max", "step"]) ?? node.id ?? "Control";
  }
  function controlUnit(node) {
    return attrValueText(node.attrs, "unit") ?? attrValueText(node.attrs, "suffix") ?? bodyFieldText(node, "unit");
  }
  function computedLabel(node, fallback) {
    return attrValueText(node.attrs, "label") ?? attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "name") ?? bodyFieldText(node, "label") ?? bodyFieldText(node, "title") ?? node.id ?? fallback;
  }
  function computedBodyHtml(node, ctx) {
    if (node.body !== void 0) {
      const text = freeformBodyText(node, [
        "formula",
        "domain",
        "range",
        "title",
        "label",
        "unit",
        "variable_label",
        "variableLabel",
        "x_label",
        "xLabel",
        "value_label",
        "valueLabel",
        "y_label",
        "yLabel"
      ]);
      return text ? `<div class="noma-computed-body"><p>${inlineToHtml(text)}</p></div>` : "";
    }
    const rendered = renderChildren(node, ctx);
    return rendered ? `<div class="noma-computed-body">${rendered}</div>` : "";
  }
  function freeformBodyText(node, metadataKeys) {
    const body = node.body ?? "";
    if (!body.trim()) return void 0;
    const metadata = new Set(metadataKeys.map((key) => key.toLowerCase()));
    const lines = body.split(/\r?\n/).filter((line) => {
      const match = /^\s*([A-Za-z_][\w.-]*)\s*:/.exec(line);
      return !match || !metadata.has(match[1].toLowerCase());
    }).map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : void 0;
  }
  function computedMetaHtml(node, formula) {
    const parsed = formula ? parseFormula(formula) : void 0;
    const deps = parsed?.ok ? extractFormulaIdentifiers(parsed.ast).join(", ") : void 0;
    return metaFieldsHtml([
      metaTextField("formula", formula),
      metaTextField("domain", computedDomainText(node)),
      metaTextField("depends on", deps),
      metaTextField("unit", controlUnit(node))
    ]);
  }
  function parseComputedTableVariable(domain) {
    return domain?.split(":", 1)[0]?.trim() || void 0;
  }
  function computedTableHeaders(node, variable) {
    const variableLabel = attrValueText(node.attrs, "variable_label") ?? attrValueText(node.attrs, "variableLabel") ?? attrValueText(node.attrs, "x_label") ?? attrValueText(node.attrs, "xLabel") ?? bodyFieldText(node, "variable_label") ?? bodyFieldText(node, "variableLabel") ?? bodyFieldText(node, "x_label") ?? bodyFieldText(node, "xLabel") ?? variable;
    const valueLabel = attrValueText(node.attrs, "value_label") ?? attrValueText(node.attrs, "valueLabel") ?? attrValueText(node.attrs, "y_label") ?? attrValueText(node.attrs, "yLabel") ?? bodyFieldText(node, "value_label") ?? bodyFieldText(node, "valueLabel") ?? bodyFieldText(node, "y_label") ?? bodyFieldText(node, "yLabel") ?? computedLabel(node, "Value");
    return [variableLabel, valueLabel];
  }
  function computedDataAttrs(node) {
    const formula = formulaText(node);
    if (!formula) return "";
    const parsed = parseFormula(formula);
    const astAttr = parsed.ok ? ` data-formula-ast="${escapeAttr(JSON.stringify(parsed.ast))}"` : "";
    return ` data-formula="${escapeAttr(formula)}"${astAttr}`;
  }
  function computedValueText(value, unit) {
    return formatControlValue(formatComputedNumber(value), unit);
  }
  function formatControlValue(value, unit) {
    if (!unit || !value) return value;
    if (value.endsWith(unit)) return value;
    if (/^[%°]/.test(unit)) return `${value}${unit}`;
    return `${value} ${unit}`;
  }
  function placeholderPlotSvg(width, height) {
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,${height - 20} ${width * 0.13},${height - 40} ${width * 0.25},${height - 30} ${width * 0.38},${height - 60} ${width * 0.5},${height - 65} ${width * 0.63},${height - 80} ${width * 0.75},${height - 85} ${width * 0.88},${height - 100} ${width},${height - 105}"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;
  }
  function renderMetric(node, idAndAttrs, ctx) {
    const label = metricLabel(node);
    const valueAttr = attrValueText(node.attrs, "value") ?? attrValueText(node.attrs, "current") ?? attrValueText(node.attrs, "amount");
    const bodyValue = directiveText(node);
    const value = valueAttr ?? bodyValue;
    const usedBodyAsValue = valueAttr === void 0 && bodyValue.length > 0;
    const valueHtml = value ? `<div class="noma-metric-value">${escapeHtml(metricValueText(value, attrValueText(node.attrs, "unit")))}</div>` : "";
    const body = usedBodyAsValue ? "" : renderChildren(node, ctx);
    const meta = metricMetaHtml(node);
    const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
    return `<aside class="noma-metric"${idAndAttrs}>
  <header class="noma-metric-head"><span class="noma-tag">Metric</span><h3>${escapeHtml(label)}</h3></header>
  ${valueHtml}
  ${body ? `<div class="noma-metric-body">${body}</div>` : ""}
  ${metaHtml}
</aside>`;
  }
  function metricLabel(node) {
    return attrValueText(node.attrs, "label") ?? attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "name") ?? node.id ?? "Metric";
  }
  function metricValueText(value, unit) {
    if (!unit || value.endsWith(unit)) return value;
    if (/^[%°]/.test(unit)) return `${value}${unit}`;
    return `${value} ${unit}`;
  }
  function metricMetaHtml(node) {
    return metaFieldsHtml([
      metaTextField("status", attrValueText(node.attrs, "status")),
      metaTextField("trend", attrValueText(node.attrs, "trend")),
      metaTextField("change", attrValueText(node.attrs, "change") ?? attrValueText(node.attrs, "delta")),
      metaTextField("target", attrValueText(node.attrs, "target")),
      metaReferenceField("source", attrValueText(node.attrs, "source")),
      metaTextField("as of", attrValueText(node.attrs, "as_of") ?? attrValueText(node.attrs, "asOf") ?? attrValueText(node.attrs, "date"))
    ]);
  }
  function renderCodeDirective(node, idAndAttrs, ctx) {
    const language = attrValueText(node.attrs, "lang") ?? attrValueText(node.attrs, "language");
    const title = attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "label") ?? node.id;
    const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
    const meta = metaFieldsHtml([metaTextField("language", language)]);
    const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
    return `<article class="noma-technical noma-code-block"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">Code</span>${titleHtml}</header>
  ${metaHtml}
  <div class="noma-technical-body">${renderCodeLikeBody(node, language, ctx)}</div>
</article>`;
  }
  function renderCodeCell(node, idAndAttrs, ctx) {
    const language = attrValueText(node.attrs, "lang") ?? attrValueText(node.attrs, "language");
    const titleHtml = language ? `<h3>${escapeHtml(language)}</h3>` : "";
    const meta = metaFieldsHtml([
      metaTextField("kernel", attrValueText(node.attrs, "kernel") ?? attrValueText(node.attrs, "runtime")),
      metaTextField("status", attrValueText(node.attrs, "status")),
      metaTextField("execution", attrValueText(node.attrs, "execution_count") ?? attrValueText(node.attrs, "count"))
    ]);
    const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
    return `<article class="noma-technical noma-code-cell"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">Code cell</span>${titleHtml}</header>
  ${metaHtml}
  <div class="noma-technical-body">${renderCodeLikeBody(node, language, ctx)}</div>
</article>`;
  }
  function renderOutputBlock(node, idAndAttrs, ctx) {
    const kind = attrValueText(node.attrs, "type") ?? attrValueText(node.attrs, "mime") ?? attrValueText(node.attrs, "format");
    const titleHtml = kind ? `<h3>${escapeHtml(kind)}</h3>` : "";
    const meta = metaFieldsHtml([
      metaReferenceField("for", attrValueText(node.attrs, "for") ?? attrValueText(node.attrs, "cell") ?? attrValueText(node.attrs, "source")),
      metaTextField("status", attrValueText(node.attrs, "status")),
      metaTextField("mime", attrValueText(node.attrs, "mime"))
    ]);
    const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
    return `<article class="noma-technical noma-output-block"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">Output</span>${titleHtml}</header>
  ${metaHtml}
  <div class="noma-technical-body">${renderCodeLikeBody(node, kind, ctx)}</div>
</article>`;
  }
  function renderCodeLikeBody(node, language, ctx) {
    if (hasSimpleCodeBody(node)) return renderTechnicalCode(simpleCodeText(node), language ?? "");
    return renderChildren(node, ctx);
  }
  function hasSimpleCodeBody(node) {
    if (node.body?.trim()) return true;
    return node.children.length > 0 && node.children.every((child) => child.type === "paragraph" || child.type === "code");
  }
  function simpleCodeText(node) {
    if (node.body !== void 0) return node.body;
    return node.children.map((child) => {
      if (child.type === "paragraph" || child.type === "code") return child.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  function renderTechnicalDirective(node, idAndAttrs, ctx) {
    const label = technicalLabel(node.name);
    const title = technicalTitle(node);
    const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
    const meta = technicalMetaHtml(node);
    const body = technicalBodyHtml(node, ctx);
    const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
    const bodyHtml = body ? `<div class="noma-technical-body">${body}</div>` : "";
    return `<article class="noma-technical noma-technical-${escapeAttr(node.name)}"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">${escapeHtml(label)}</span>${titleHtml}</header>
  ${metaHtml}
  ${bodyHtml}
</article>`;
  }
  function technicalLabel(name) {
    switch (name) {
      case "api":
        return "API";
      case "endpoint":
        return "Endpoint";
      case "parameter":
        return "Parameter";
      case "example":
        return "Example";
      case "query":
        return "Query";
      case "instruction":
        return "Instruction";
      case "changelog":
        return "Changelog";
      default:
        return name;
    }
  }
  function technicalTitle(node) {
    const title = stringAttr2(node.attrs, "title") ?? stringAttr2(node.attrs, "label");
    if (title) return title;
    switch (node.name) {
      case "api":
        return stringAttr2(node.attrs, "name") ?? node.id;
      case "endpoint": {
        const method = stringAttr2(node.attrs, "method")?.toUpperCase();
        const path = stringAttr2(node.attrs, "path");
        if (method && path) return `${method} ${path}`;
        return path ?? method ?? node.id;
      }
      case "parameter":
        return stringAttr2(node.attrs, "name") ?? node.id;
      case "example":
        return stringAttr2(node.attrs, "for") ? `for ${stringAttr2(node.attrs, "for")}` : node.id;
      case "query":
        return stringAttr2(node.attrs, "dataset") ? `for ${stringAttr2(node.attrs, "dataset")}` : node.id;
      case "changelog":
        return stringAttr2(node.attrs, "version") ?? stringAttr2(node.attrs, "date") ?? node.id;
      case "instruction":
        return stringAttr2(node.attrs, "scope") ?? stringAttr2(node.attrs, "audience") ?? node.id;
      default:
        return node.id;
    }
  }
  function technicalMetaHtml(node) {
    const keys = technicalMetaKeys(node.name);
    const items = keys.filter((key) => node.attrs[key] !== void 0).map((key) => `<span><span class="noma-meta-key">${escapeHtml(technicalMetaLabel(key))}</span> ${technicalValueHtml(key, node.attrs[key])}</span>`);
    return items.join(" \xB7 ");
  }
  function technicalMetaKeys(name) {
    switch (name) {
      case "api":
        return ["version", "base_url", "status", "owner"];
      case "endpoint":
        return ["method", "path", "auth", "api", "status"];
      case "parameter":
        return ["name", "in", "type", "required", "default", "enum"];
      case "example":
        return ["lang", "for", "status"];
      case "query":
        return ["lang", "dataset", "source", "status"];
      case "instruction":
        return ["scope", "audience", "priority", "owner"];
      case "changelog":
        return ["version", "date", "status"];
      default:
        return [];
    }
  }
  function technicalMetaLabel(key) {
    if (key === "base_url") return "base URL";
    if (key === "lang") return "language";
    return key.replace(/_/g, " ");
  }
  function technicalValueHtml(key, value) {
    const text = String(value ?? "");
    if (key === "base_url" || /^https?:\/\//.test(text)) {
      return `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
    }
    if (key === "api" || key === "for" || key === "dataset") {
      return `<a href="#${escapeAttr(text)}">${escapeHtml(text)}</a>`;
    }
    if (key === "method" || key === "path" || key === "type" || key === "default" || key === "enum") {
      return `<code>${escapeHtml(text)}</code>`;
    }
    return escapeHtml(text);
  }
  function technicalBodyHtml(node, ctx) {
    const language = technicalLanguage(node);
    if ((node.name === "example" || node.name === "query") && language && hasSimpleCodeBody(node)) {
      return renderTechnicalCode(simpleCodeText(node), language);
    }
    return renderChildren(node, ctx);
  }
  function technicalLanguage(node) {
    return stringAttr2(node.attrs, "lang") ?? stringAttr2(node.attrs, "language");
  }
  function renderTechnicalCode(source, language) {
    const langClass = language ? ` class="lang-${escapeAttr(language)}"` : "";
    return `<pre class="noma-technical-code"><code${langClass}>${escapeHtml(source)}</code></pre>`;
  }
  function attrValueText(attrs, key) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return void 0;
  }
  function metaTextField(label, value) {
    return value ? `<span><span class="noma-meta-key">${escapeHtml(label)}</span> ${escapeHtml(value)}</span>` : void 0;
  }
  function metaReferenceField(label, value) {
    if (!value) return void 0;
    return `<span><span class="noma-meta-key">${escapeHtml(label)}</span> ${referenceValueHtml(value)}</span>`;
  }
  function metaDoiField(value) {
    if (!value) return void 0;
    const href = /^https?:\/\//.test(value) ? value : `https://doi.org/${value}`;
    return `<span><span class="noma-meta-key">doi</span> <a href="${escapeAttr(href)}">${escapeHtml(value)}</a></span>`;
  }
  function referenceValueHtml(value) {
    if (/^https?:\/\//.test(value)) return `<a href="${escapeAttr(value)}">${escapeHtml(value)}</a>`;
    return `<a href="#${escapeAttr(value)}">${escapeHtml(value)}</a>`;
  }
  function metaFieldsHtml(fields) {
    return fields.filter((field) => Boolean(field)).join(" \xB7 ");
  }
  function renderDiagram(node, idAttr) {
    const kind = String(node.attrs.kind ?? "mermaid").toLowerCase();
    const body = node.body ?? "";
    const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "";
    if (kind === "drawio") {
      const config = JSON.stringify({
        highlight: "#0066cc",
        nav: true,
        resize: true,
        toolbar: "zoom layers tags lightbox",
        edit: "_blank",
        xml: body
      });
      const fig = `<div class="mxgraph" data-mxgraph="${escapeAttr(config)}"></div>`;
      return wrapDiagram("drawio", idAttr, fig, caption);
    }
    const cls = `noma-diagram noma-diagram-${escapeAttr(kind)}`;
    const placeholder = `<pre class="noma-diagram-source">${escapeHtml(body)}</pre>`;
    const figure = `<div class="${cls}" data-noma-source="${escapeAttr(body)}">${placeholder}</div>`;
    return wrapDiagram(kind, idAttr, figure, caption);
  }
  function wrapDiagram(kind, idAttr, inner, caption) {
    const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
    return `<figure class="noma-diagram-wrap" data-kind="${escapeAttr(kind)}"${idAttr}>${inner}${cap}</figure>`;
  }
  function renderPlotly(node, idAttr) {
    const body = node.body ?? "";
    const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "";
    const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
    return `<figure class="noma-plotly-wrap"${idAttr}><div class="noma-plotly" data-noma-source="${escapeAttr(body)}"></div>${cap}</figure>`;
  }
  function renderPlotPlaceholder(node, idAttr, ctx) {
    const title = node.attrs.title ? String(node.attrs.title) : "Plot";
    const dataSrc = node.attrs.data ?? node.attrs.dataset ?? "\u2014";
    const plot = renderPlotSvgForNode(node, ctx.datasets);
    const compactAttr = plot.compact ? ` data-compact="true"` : "";
    return `<figure class="noma-plot"${idAttr}${compactAttr}>
  <div class="noma-plot-canvas" data-type="${escapeAttr(plot.type)}" data-source="${escapeAttr(String(dataSrc))}">
    ${plot.svg}
  </div>
  <figcaption>${escapeHtml(title)} <span class="noma-meta-key">type</span> ${escapeHtml(plot.type)} \xB7 <span class="noma-meta-key">source</span> ${escapeHtml(plot.sourceLabel)}</figcaption>
</figure>`;
  }
  function renderPlotSvgForNode(node, datasets) {
    const dataSrc = node.attrs.data ?? node.attrs.dataset ?? "\u2014";
    const type2 = String(node.attrs.type ?? "line");
    const width = Number(node.attrs.width ?? 320);
    const compact = attrBool(node.attrs.compact);
    const height = Number(node.attrs.height ?? (compact ? 112 : 140));
    const labelOptions = plotLabelOptionsFromAttrs(node.attrs, compact);
    const multi = resolveFromDatasetMulti(node, datasets);
    let seriesList;
    let labels;
    if (multi) {
      seriesList = multi.series;
      labels = multi.labels;
    } else {
      const single = resolveFromDataset(node, datasets);
      const values = single?.values ?? parseSeries(node);
      seriesList = values.length >= 2 ? [{ name: single?.column ?? String(node.attrs.column ?? ""), values }] : [];
      labels = single?.labels ?? parseLabels(node);
    }
    const totalPoints = seriesList.reduce((s, ser) => s + ser.values.length, 0);
    const svg = seriesList.length > 0 && seriesList[0].values.length >= 2 ? renderChartSvg(seriesList, type2, width, height, labels, labelOptions) : `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,${height - 20} ${width * 0.13},${height - 40} ${width * 0.25},${height - 30} ${width * 0.38},${height - 60} ${width * 0.5},${height - 65} ${width * 0.63},${height - 80} ${width * 0.75},${height - 85} ${width * 0.88},${height - 100} ${width},${height - 105}"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;
    const sourceLabel = totalPoints >= 2 ? `${seriesList[0].values.length} points${seriesList.length > 1 ? ` \xD7 ${seriesList.length} series` : ""}` : String(dataSrc);
    return { svg, type: type2, width, height, compact, sourceLabel, totalPoints };
  }
  function resolveFromDataset(node, datasets) {
    const dsId = node.attrs.dataset;
    if (typeof dsId !== "string") return null;
    const table = datasets.get(dsId);
    if (!table) return null;
    const column = typeof node.attrs.column === "string" ? node.attrs.column : void 0;
    const resolved = resolvePlotData(table, column);
    if (!resolved) return null;
    const xColumn = typeof node.attrs.xcolumn === "string" ? node.attrs.xcolumn : void 0;
    const labels = xColumn ? resolvePlotLabels(table, xColumn) ?? [] : parseLabels(node);
    return { values: resolved.values, labels, column: resolved.column };
  }
  function resolveFromDatasetMulti(node, datasets) {
    const dsId = node.attrs.dataset;
    if (typeof dsId !== "string") return null;
    const table = datasets.get(dsId);
    if (!table) return null;
    const colsAttr = node.attrs.columns;
    if (typeof colsAttr !== "string") return null;
    const colNames = colsAttr.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (colNames.length === 0) return null;
    const series = [];
    for (const name of colNames) {
      const resolved = resolvePlotData(table, name);
      if (!resolved) continue;
      series.push({ name: resolved.column, values: resolved.values });
    }
    if (series.length === 0) return null;
    const xColumn = typeof node.attrs.xcolumn === "string" ? node.attrs.xcolumn : void 0;
    const labels = xColumn ? resolvePlotLabels(table, xColumn) ?? [] : parseLabels(node);
    return { series, labels };
  }
  function parseSeries(node) {
    const tryParse = (raw) => {
      const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const nums = parts.map(Number);
      if (nums.length >= 2 && nums.every((n) => Number.isFinite(n))) return nums;
      return [];
    };
    const data = node.attrs.data;
    if (typeof data === "string" && !data.includes("/") && !data.endsWith(".csv")) {
      const fromAttr = tryParse(data);
      if (fromAttr.length) return fromAttr;
    }
    if (typeof data === "number") return [];
    if (node.body) {
      const lines = node.body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^[a-zA-Z_]+\s*:/.test(l));
      const inline = tryParse(lines.join(" "));
      if (inline.length) return inline;
    }
    return [];
  }
  function parseLabels(node) {
    const raw = node.attrs.xlabels;
    if (typeof raw !== "string") return [];
    return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }
  var PLOT_COLORS = [
    "currentColor",
    "#cf6037",
    "#2e8b57",
    "#8b6c1a",
    "#5a6071",
    "#a8362e"
  ];
  function plotLabelOptionsFromAttrs(attrs, compact) {
    const angle = numericAttr2(attrs, "xlabel_angle");
    const wrap2 = numericAttr2(attrs, "xlabel_wrap");
    const abbrev = numericAttr2(attrs, "xlabel_abbrev");
    return {
      ...angle !== void 0 ? { xLabelAngle: normalizeXLabelAngle(angle) } : {},
      ...wrap2 !== void 0 ? { xLabelWrap: Math.max(1, Math.floor(wrap2)) } : {},
      ...abbrev !== void 0 ? { xLabelAbbrev: Math.max(4, Math.floor(abbrev)) } : {},
      compact
    };
  }
  function numericAttr2(attrs, key) {
    const raw = attrs[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw !== "string" || !raw.trim()) return void 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : void 0;
  }
  function attrBool(value) {
    if (value === true) return true;
    if (typeof value === "string") return value === "true" || value === "yes";
    return false;
  }
  function normalizeXLabelAngle(value) {
    if (value === 0) return 0;
    return -Math.min(90, Math.abs(value));
  }
  function formatPlotLabel(label, options) {
    let text = label;
    let shortened = false;
    if (options.xLabelAbbrev !== void 0 && text.length > options.xLabelAbbrev) {
      text = `${text.slice(0, Math.max(1, options.xLabelAbbrev - 3))}...`;
      shortened = true;
    }
    const lines = options.xLabelWrap !== void 0 ? wrapPlotLabel(text, options.xLabelWrap) : [text];
    return { full: label, lines, shortened };
  }
  function wrapPlotLabel(label, maxChars) {
    if (label.length <= maxChars) return [label];
    const chunks = [];
    const parts = label.split(/([_\-\s]+)/).filter(Boolean);
    let line = "";
    const pushLine = () => {
      const trimmed = line.trim();
      if (trimmed) chunks.push(trimmed);
      line = "";
    };
    for (const part of parts) {
      if (part.length > maxChars) {
        pushLine();
        for (let i = 0; i < part.length; i += maxChars) {
          chunks.push(part.slice(i, i + maxChars));
        }
        continue;
      }
      if ((line + part).trim().length > maxChars) pushLine();
      line += part;
    }
    pushLine();
    return chunks.length > 0 ? chunks : [label];
  }
  function renderPlotLabel(label, x, y, angle, anchor, fontPx, lineH) {
    const transform = angle !== 0 ? ` transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle})"` : ` x="${x.toFixed(1)}" y="${y.toFixed(1)}"`;
    const tspanX = angle !== 0 ? "0" : x.toFixed(1);
    const title = label.shortened ? `<title>${escapeHtml(label.full)}</title>` : "";
    const tspans = label.lines.map((line, idx) => `<tspan x="${tspanX}" dy="${idx === 0 ? 0 : lineH}">${escapeHtml(line)}</tspan>`).join("");
    return `<text${transform} text-anchor="${anchor}" font-size="${fontPx}" fill="currentColor" opacity="0.7">${title}${tspans}</text>`;
  }
  function renderChartSvg(seriesList, type2, w, h, labels, labelOptions) {
    const isBar = type2 === "bar";
    const nSeries = seriesList.length;
    const N = seriesList[0]?.values.length ?? 0;
    const showLegend = nSeries > 1;
    const FONT_PX = 9;
    const LINE_H = 11;
    const CHAR_W = 5.5;
    const labelTexts = labels.map((label) => formatPlotLabel(label, labelOptions));
    const innerWProbe = w - 28 - (isBar ? 12 : 6);
    const slotW = labels.length ? innerWProbe / Math.max(1, N) : 0;
    const longest = labelTexts.reduce(
      (m, l) => Math.max(m, l.lines.reduce((lineMax, line) => Math.max(lineMax, line.length * CHAR_W), 0)),
      0
    );
    const maxLabelLines = labelTexts.reduce((m, l) => Math.max(m, l.lines.length), 1);
    const autoAngle = isBar && labels.length > 1 && longest > slotW * 0.95 ? -35 : 0;
    const xLabelAngle = labelOptions.xLabelAngle ?? autoAngle;
    const rotateLabels = xLabelAngle !== 0;
    const padL = 28;
    const padR = isBar ? 12 : 6;
    const padT = showLegend ? 22 : labelOptions.compact ? 6 : 8;
    const straightLabelH = maxLabelLines * LINE_H + 8;
    const rotatedLabelH = Math.ceil(longest * Math.sin(Math.abs(xLabelAngle) * Math.PI / 180)) + maxLabelLines * LINE_H + 8;
    const padB = labels.length ? rotateLabels ? Math.min(labelOptions.compact ? 48 : 82, rotatedLabelH) : Math.min(labelOptions.compact ? 36 : 64, straightLabelH) : labelOptions.compact ? 6 : 8;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const allValues = seriesList.flatMap((s) => s.values);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const span = max - min || 1;
    const x = (i) => {
      if (N === 1) return padL + innerW / 2;
      if (isBar) return padL + (i + 0.5) / N * innerW;
      return padL + i / (N - 1) * innerW;
    };
    const y = (v) => padT + innerH - (v - min) / span * innerH;
    const gridY = [0, 0.25, 0.5, 0.75, 1].map(
      (t) => `<line x1="${padL}" x2="${w - padR}" y1="${padT + t * innerH}" y2="${padT + t * innerH}" stroke="currentColor" stroke-opacity="0.12" />`
    ).join("");
    let plot = "";
    if (type2 === "bar") {
      const slotInner = innerW / N * 0.85;
      const barW = slotInner / nSeries;
      plot = seriesList.map(
        (ser, sIdx) => ser.values.map((v, i) => {
          const slotCenter = x(i);
          const cx = slotCenter - slotInner / 2 + sIdx * barW + barW / 2;
          const top = y(v);
          return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + innerH - top).toFixed(1)}" fill="${PLOT_COLORS[sIdx % PLOT_COLORS.length]}" opacity="0.85" />`;
        }).join("")
      ).join("");
    } else {
      const showMarkers = N <= 30;
      plot = seriesList.map((ser, sIdx) => {
        const color = PLOT_COLORS[sIdx % PLOT_COLORS.length];
        const points = ser.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        const areaFill = sIdx === 0 && nSeries === 1 ? `<path d="M ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} L ${points.split(" ").join(" L ")} L ${x(N - 1).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="${color}" opacity="0.12" />` : "";
        const line = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" />`;
        const markers = showMarkers ? ser.values.map(
          (v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${color}" />`
        ).join("") : "";
        return areaFill + line + markers;
      }).join("");
    }
    const yTickVals = [0, 0.25, 0.5, 0.75, 1].map((t) => max - t * span);
    const yLabels = yTickVals.map(
      (v, idx) => `<text x="${padL - 4}" y="${(padT + idx * innerH * 0.25 + 3).toFixed(1)}" text-anchor="end" font-size="${FONT_PX}" fill="currentColor" opacity="0.7">${escapeHtml(formatNum(v))}</text>`
    ).join("");
    let xLabels = "";
    if (labels.length) {
      if (isBar) {
        xLabels = Array.from({ length: N }).map((_, i) => {
          const label = labelTexts[i];
          if (!label || label.lines.length === 0) return "";
          const cx = x(i);
          const yPos = padT + innerH + 12;
          return renderPlotLabel(label, cx, yPos, rotateLabels ? xLabelAngle : 0, rotateLabels ? "end" : "middle", FONT_PX, LINE_H);
        }).join("");
      } else {
        const T = Math.min(6, N);
        const idxs = Array.from(
          { length: T },
          (_, k) => Math.round(k * (N - 1) / Math.max(1, T - 1))
        );
        xLabels = idxs.map((i, k) => {
          const label = labelTexts[i];
          if (!label || label.lines.length === 0) return "";
          const cx = x(i);
          const anchor = k === 0 ? "start" : k === T - 1 ? "end" : "middle";
          return renderPlotLabel(label, cx, padT + innerH + 12, rotateLabels ? xLabelAngle : 0, rotateLabels ? "end" : anchor, FONT_PX, LINE_H);
        }).join("");
      }
    }
    let legend = "";
    if (showLegend) {
      let cursor = padL;
      legend = seriesList.map((ser, sIdx) => {
        const color = PLOT_COLORS[sIdx % PLOT_COLORS.length];
        const swatchX = cursor;
        const textX = cursor + 14;
        const labelW = ser.name.length * CHAR_W + 22;
        cursor += labelW;
        return `<rect x="${swatchX}" y="6" width="10" height="10" fill="${color}" opacity="0.85" /><text x="${textX}" y="14" font-size="${FONT_PX}" fill="currentColor" opacity="0.85">${escapeHtml(ser.name)}</text>`;
      }).join("");
    }
    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">
    ${gridY}
    ${plot}
    ${yLabels}
    ${xLabels}
    ${legend}
  </svg>`;
  }
  function formatNum(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
    if (a >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
  function renderChildren(node, ctx) {
    if (node.children.length === 0 && node.body !== void 0) {
      return `<p>${inlineToHtml(node.body)}</p>`;
    }
    return node.children.map((c) => renderNode(c, ctx)).join("\n");
  }
  function wrap(tag, className, idAndAttrs, inner) {
    return `<${tag} class="${className}"${idAndAttrs}>${inner}</${tag}>`;
  }
  function extractFirstHeading(doc) {
    for (const n of doc.children) {
      if (n.type === "section") return n.title;
    }
    return void 0;
  }

  // src/renderer-json.ts
  function renderJson(doc, options = {}) {
    return JSON.stringify(doc, null, options.pretty === false ? 0 : 2);
  }

  // src/renderer-llm.ts
  var STALE_OPT_IN_TYPES = /* @__PURE__ */ new Set(["project", "reference"]);
  function renderLlm(doc, options = {}) {
    const ctx = {
      ...options,
      excludedMemoryIds: computeExcludedMemoryIds(doc, options),
      selectSet: normalizeSelectors(options.select),
      excludeSet: normalizeSelectors(options.exclude),
      computed: buildComputedEvalContext(doc)
    };
    const out = [];
    if (doc.meta.title) out.push(`# ${String(doc.meta.title)}`);
    for (const child of doc.children) {
      if (shouldEmit(child, ctx, false)) emit(child, out, 0, ctx, false);
    }
    const rendered = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return applyBudget(rendered, options.budget);
  }
  function normalizeSelectors(values) {
    const out = /* @__PURE__ */ new Set();
    for (const raw of values ?? []) {
      for (const part of raw.split(/[,\s]+/)) {
        const clean = part.trim().toLowerCase();
        if (clean) out.add(clean);
      }
    }
    return out;
  }
  function applyBudget(text, budget) {
    if (budget === void 0 || !Number.isFinite(budget) || budget <= 0) return text;
    if (text.length <= budget) return text;
    const marker = `

[LLM context truncated at ${budget} characters]
`;
    if (budget <= marker.length) return marker.slice(0, budget);
    const limit = budget - marker.length;
    const cut = text.lastIndexOf("\n", limit);
    return text.slice(0, cut > 0 ? cut : limit).trimEnd() + marker;
  }
  function computeExcludedMemoryIds(doc, options) {
    const excluded = /* @__PURE__ */ new Set();
    if (!options.excludeStale) return excluded;
    for (const node of walk(doc)) {
      if (node.type !== "directive") continue;
      if (node.name !== "memory") continue;
      if (!node.id) continue;
      if (isStale(node, options.excludeStale)) excluded.add(node.id);
    }
    return excluded;
  }
  function emit(node, out, depth, opts, forceSubtree) {
    switch (node.type) {
      case "document":
        for (const child of node.children) {
          if (shouldEmit(child, opts, forceSubtree)) emit(child, out, depth, opts, forceSubtree);
        }
        return;
      case "section":
        emitSection(node, out, depth, opts, forceSubtree);
        return;
      case "paragraph":
        out.push(inlineToPlain(node.content));
        out.push("");
        return;
      case "code":
        out.push("```" + (node.lang ?? ""));
        out.push(node.content);
        out.push("```");
        out.push("");
        return;
      case "list":
        for (const item of node.items) {
          out.push(`- ${inlineToPlain(item.content)}`);
        }
        out.push("");
        return;
      case "list_item":
        out.push(`- ${inlineToPlain(node.content)}`);
        return;
      case "quote":
        for (const line of node.content.split("\n")) out.push(`> ${line}`);
        out.push("");
        return;
      case "thematic_break":
        out.push("---");
        out.push("");
        return;
      case "table": {
        const widths = node.header.map(
          (h, i) => Math.max(
            h.length,
            ...node.rows.map((r) => (r[i] ?? "").length),
            3
          )
        );
        const fmt = (cells) => "| " + cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join(" | ") + " |";
        out.push(fmt(node.header));
        out.push(
          "| " + widths.map((w, i) => {
            const a = node.align[i];
            const dashes = "-".repeat(Math.max(3, w));
            if (a === "center") return `:${dashes.slice(0, -2)}-:`;
            if (a === "right") return `${dashes.slice(0, -1)}:`;
            if (a === "left") return `:${dashes.slice(0, -1)}`;
            return dashes;
          }).join(" | ") + " |"
        );
        for (const row of node.rows) out.push(fmt(row));
        out.push("");
        return;
      }
      case "directive":
        emitDirective(node, out, depth, opts, forceSubtree);
        return;
      case "frontmatter":
        return;
      default: {
        const _exhaustive = node;
        void _exhaustive;
      }
    }
  }
  function emitSection(node, out, depth, opts, forceSubtree) {
    const hashes = "#".repeat(node.level);
    out.push(`${hashes} ${node.title}${node.id ? `  [#${node.id}]` : ""}`);
    out.push("");
    const childForce = forceSubtree || matchesSelector(node, opts.selectSet);
    for (const child of node.children) {
      if (shouldEmit(child, opts, childForce)) emit(child, out, depth, opts, childForce);
    }
  }
  var VERBATIM_BODY = /* @__PURE__ */ new Set(["diagram", "plotly", "math"]);
  function emitDirective(node, out, depth, opts, forceSubtree) {
    if (node.name === "html" || node.name === "svg" || node.name === "script") {
      out.push(`[${node.name.toUpperCase()} escape-hatch block omitted from LLM context]`);
      out.push("");
      return;
    }
    if (node.name === "memory" && opts.excludeStale && isStale(node, opts.excludeStale)) {
      return;
    }
    const tag = node.name.toUpperCase();
    const attrs = Object.entries(node.attrs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    out.push(`[${tag}${attrs ? " " + attrs : ""}]`);
    if (node.name === "computed_metric" || node.name === "computed_plot" || node.name === "computed_table") {
      emitComputedSummary(node, out, opts);
    }
    const isIndexWithExclusions = node.name === "memory_index" && opts.excludedMemoryIds.size > 0;
    const childForce = forceSubtree || matchesSelector(node, opts.selectSet);
    if (VERBATIM_BODY.has(node.name) && node.body !== void 0) {
      out.push(node.body);
    } else if (node.children.length === 0 && node.body !== void 0) {
      const body = isIndexWithExclusions ? filterMemoryIndexBody(node.body, opts.excludedMemoryIds) : node.body;
      out.push(inlineToPlain(body));
    } else if (isIndexWithExclusions) {
      for (const child of node.children)
        emitFilteredIndexChild(child, out, depth + 1, opts);
    } else {
      for (const child of node.children) {
        if (shouldEmit(child, opts, childForce)) emit(child, out, depth + 1, opts, childForce);
      }
    }
    out.push(`[/${tag}]`);
    out.push("");
  }
  function emitComputedSummary(node, out, opts) {
    const formula = formulaText(node);
    if (!formula) {
      out.push("formula: <missing>");
      return;
    }
    out.push(`formula: ${formula}`);
    if (node.name === "computed_plot" || node.name === "computed_table") {
      const series = evaluateComputedSeries(node, opts.computed);
      if (series) {
        const values = node.name === "computed_table" ? series.points.map((point, index) => `${formatComputedNumber(point)}=${formatComputedNumber(series.values[index])}`) : series.values.map(formatComputedNumber);
        out.push(`default_series (${series.variable}): ${values.join(", ")}`);
        return;
      }
    }
    const value = evaluateComputedNode(node, opts.computed);
    if (value !== void 0) out.push(`default: ${formatComputedNumber(value)}`);
  }
  function shouldEmit(node, opts, forceSubtree) {
    if (matchesSelector(node, opts.excludeSet)) return false;
    if (forceSubtree || opts.selectSet.size === 0) return true;
    if (matchesSelector(node, opts.selectSet)) return true;
    return hasSelectableDescendant(node, opts);
  }
  function hasSelectableDescendant(node, opts) {
    for (const child of childrenOf(node)) {
      if (matchesSelector(child, opts.excludeSet)) continue;
      if (matchesSelector(child, opts.selectSet)) return true;
      if (hasSelectableDescendant(child, opts)) return true;
    }
    return false;
  }
  function matchesSelector(node, selectors) {
    if (selectors.size === 0) return false;
    if (selectors.has(node.type)) return true;
    return node.type === "directive" && selectors.has(node.name.toLowerCase());
  }
  function childrenOf(node) {
    if (node.type === "document" || node.type === "section" || node.type === "directive") {
      return node.children;
    }
    if (node.type === "list") return node.items;
    return [];
  }
  var WIKILINK_RE = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;
  function filterMemoryIndexBody(body, excluded) {
    if (excluded.size === 0) return body;
    return body.split("\n").filter((line) => {
      const matches = [...line.matchAll(WIKILINK_RE)];
      if (matches.length === 0) return true;
      return !matches.every((m) => excluded.has(m[1]));
    }).join("\n");
  }
  function emitFilteredIndexChild(node, out, depth, opts) {
    if (node.type === "list") {
      const survivors = node.items.filter((item) => {
        const matches = [...item.content.matchAll(WIKILINK_RE)];
        if (matches.length === 0) return true;
        return !matches.every((m) => opts.excludedMemoryIds.has(m[1]));
      });
      if (survivors.length === 0) return;
      for (const item of survivors)
        out.push(`- ${inlineToPlain(item.content)}`);
      out.push("");
      return;
    }
    if (node.type === "paragraph") {
      const matches = [...node.content.matchAll(WIKILINK_RE)];
      const allExcluded = matches.length > 0 && matches.every((m) => opts.excludedMemoryIds.has(m[1]));
      if (allExcluded) return;
      out.push(inlineToPlain(node.content));
      out.push("");
      return;
    }
    emit(node, out, depth, opts, false);
  }
  function isStale(node, cfg) {
    const ls = node.attrs.last_seen;
    if (typeof ls !== "string" || !ls) return false;
    const t = Date.parse(ls);
    if (Number.isNaN(t)) return false;
    const type2 = typeof node.attrs.type === "string" ? node.attrs.type : "";
    const expired = node.attrs.expired === true;
    if (!STALE_OPT_IN_TYPES.has(type2) && !expired) return false;
    return cfg.now.getTime() - t > cfg.days * 24 * 60 * 60 * 1e3;
  }

  // src/validator.ts
  var DEFAULT_STALE_DAYS = 365;
  var PROFILES = {
    minimal: /* @__PURE__ */ new Set([
      "summary",
      "abstract",
      "callout",
      "note",
      "warning",
      "tip",
      "header",
      "footer",
      "page_setup",
      "doc_protection",
      "toc",
      "figure",
      "citation",
      "footnote",
      "endnote",
      "bibliography",
      "math",
      "code",
      "table",
      "pagebreak"
    ]),
    technical: /* @__PURE__ */ new Set([
      "summary",
      "abstract",
      "callout",
      "note",
      "warning",
      "tip",
      "hero",
      "grid",
      "card",
      "columns",
      "tabs",
      "accordion",
      "sidebar",
      "button",
      "api",
      "endpoint",
      "parameter",
      "example",
      "changelog",
      "instruction",
      "header",
      "footer",
      "page_setup",
      "doc_protection",
      "toc",
      "pagebreak",
      "figure",
      "plot",
      "plotly",
      "diagram",
      "dataset",
      "query",
      "code",
      "code_cell",
      "output",
      "control",
      "computed_metric",
      "computed_plot",
      "computed_table",
      "export_button",
      "agent_task",
      "todo",
      "citation",
      "footnote",
      "endnote",
      "bibliography",
      "math",
      "table",
      "html",
      "svg",
      "script"
    ]),
    research: /* @__PURE__ */ new Set([
      "summary",
      "abstract",
      "callout",
      "note",
      "warning",
      "tip",
      "header",
      "footer",
      "page_setup",
      "doc_protection",
      "toc",
      "claim",
      "evidence",
      "counterevidence",
      "assumption",
      "risk",
      "hypothesis",
      "result",
      "limitation",
      "open_question",
      "decision",
      "adr",
      "dataset",
      "query",
      "plot",
      "plotly",
      "diagram",
      "metric",
      "control",
      "computed_metric",
      "computed_plot",
      "computed_table",
      "code",
      "figure",
      "agent_task",
      "todo",
      "instruction",
      "review",
      "comment",
      "change_request",
      "provenance",
      "confidence",
      "citation",
      "footnote",
      "endnote",
      "bibliography",
      "state_change",
      "math",
      "table",
      "pagebreak"
    ]),
    memory: /* @__PURE__ */ new Set(["memory", "memory_index"])
  };
  var MEMORY_TYPES = /* @__PURE__ */ new Set(["user", "feedback", "project", "reference"]);
  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
  var KNOWN_PROFILES = Object.keys(PROFILES);
  function validate(doc, options = {}) {
    const requireEvidence = options.requireEvidenceForClaims !== false;
    const metaStale = readPositiveNumber(doc.meta.stale_citation_days);
    const staleDays = options.staleCitationDays ?? metaStale ?? DEFAULT_STALE_DAYS;
    const now = options.now ?? /* @__PURE__ */ new Date();
    const diagnostics = [];
    const ids = /* @__PURE__ */ new Map();
    const aliasIds = /* @__PURE__ */ new Set();
    const claims = [];
    const evidenceTargets = /* @__PURE__ */ new Set();
    const referenced = /* @__PURE__ */ new Set();
    const datasetIds = /* @__PURE__ */ new Map();
    const datasetColumns = /* @__PURE__ */ new Map();
    const controls = /* @__PURE__ */ new Map();
    const computed = /* @__PURE__ */ new Map();
    const computedNodes = [];
    const aliasToNode = /* @__PURE__ */ new Map();
    const declaredProfiles = readDeclaredProfiles(doc.meta);
    const profileSet = (() => {
      if (declaredProfiles.length === 0) return void 0;
      const union = /* @__PURE__ */ new Set();
      let any = false;
      for (const name of declaredProfiles) {
        const set2 = PROFILES[name];
        if (!set2) {
          diagnostics.push({
            severity: "warning",
            code: "unknown-profile",
            message: `Document declares unknown profile "${name}". Known: ${KNOWN_PROFILES.join(", ")}.`
          });
          continue;
        }
        any = true;
        for (const directive of set2) union.add(directive);
      }
      return any ? union : void 0;
    })();
    const profileLabel = declaredProfiles.join("+");
    const wikilinkRe = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;
    const wikilinkRefs = /* @__PURE__ */ new Set();
    const collectWikilinks = (text) => {
      const stripped = text.replace(/`[^`]*`/g, "");
      for (const m of stripped.matchAll(wikilinkRe)) {
        referenced.add(m[1]);
        wikilinkRefs.add(m[1]);
      }
    };
    for (const node of walk(doc)) {
      if (node.type === "paragraph" || node.type === "quote") collectWikilinks(node.content);
      else if (node.type === "list_item") collectWikilinks(node.content);
      else if (node.type === "section") collectWikilinks(node.title);
      else if (node.type === "directive" && node.body) collectWikilinks(node.body);
      else if (node.type === "table") {
        for (const cell of node.header) collectWikilinks(cell);
        for (const row of node.rows) for (const cell of row) collectWikilinks(cell);
      }
      if (node.id) {
        if (ids.has(node.id)) {
          diagnostics.push({
            severity: "error",
            code: "duplicate-id",
            message: `Duplicate block ID "${node.id}".`,
            pos: node.pos,
            nodeId: node.id
          });
        } else {
          ids.set(node.id, node);
        }
      }
      if (node.aliases) {
        for (const a of node.aliases) {
          aliasIds.add(a);
          if (!aliasToNode.has(a)) aliasToNode.set(a, node);
        }
      }
      if (node.type !== "directive") continue;
      if (profileSet && !suppressed(node) && !profileSet.has(node.name)) {
        diagnostics.push({
          severity: "warning",
          code: "out-of-profile-directive",
          message: `Directive "${node.name}" is not part of the declared "${profileLabel}" profile.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if (node.name === "dataset") {
        if (node.id) {
          datasetIds.set(node.id, node);
          datasetColumns.set(node.id, readDatasetColumns(node));
        }
        if (!suppressed(node) && typeof node.attrs.src === "string" && (!(node.body && node.body.trim()) || node.attrs.format === "error")) {
          diagnostics.push({
            severity: "warning",
            code: "dataset-src-missing",
            message: `Dataset "${node.id ?? "?"}" src="${node.attrs.src}" failed to load (file missing or unreadable).`,
            pos: node.pos,
            nodeId: node.id
          });
        }
      }
      if (node.name === "control") {
        if (node.id) controls.set(node.id, node);
        if (!suppressed(node)) {
          validateControl(node, diagnostics);
          validateControlLock(node, diagnostics);
        }
      }
      if (node.name === "computed_metric" || node.name === "computed_plot" || node.name === "computed_table") {
        if (node.id) computed.set(node.id, node);
        computedNodes.push(node);
      }
      if (node.name === "claim" && node.id) claims.push(node);
      if (node.name === "claim" && !suppressed(node) && "confidence" in node.attrs) {
        const c = node.attrs.confidence;
        let num = null;
        if (typeof c === "number" && Number.isFinite(c)) num = c;
        else if (typeof c === "string" && c.trim() !== "") {
          const n = Number(c);
          if (Number.isFinite(n)) num = n;
        }
        if (num === null || num < 0 || num > 1) {
          diagnostics.push({
            severity: "warning",
            code: "claim-invalid-confidence",
            message: `Claim "${node.id ?? "?"}" confidence="${c}" must be a number in [0, 1].`,
            pos: node.pos,
            nodeId: node.id
          });
        }
      }
      if (node.name === "state_change" && !suppressed(node)) {
        const block = node.attrs.block;
        if (typeof block === "string") {
          referenced.add(block);
        } else {
          diagnostics.push({
            severity: "warning",
            code: "state-change-missing-block",
            message: `state_change has no \`block=\` attribute pointing at the changed block.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
        const hasFrom = "from" in node.attrs;
        const hasTo = "to" in node.attrs;
        if (!hasFrom || !hasTo) {
          diagnostics.push({
            severity: "warning",
            code: "state-change-missing-from-to",
            message: `state_change "${node.id ?? "?"}" needs both \`from=\` and \`to=\` attributes.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
      }
      if (node.name === "comment" && !suppressed(node)) {
        const target = readFirstStringAttr(node, ["target", "for", "parent", "block", "ref"]);
        if (target) referenced.add(target);
        const replyTo = readFirstStringAttr(node, ["reply_to", "replyTo", "reply"]);
        if (replyTo) referenced.add(replyTo);
      }
      if (node.name === "change_request" && !suppressed(node)) {
        const target = readFirstStringAttr(node, ["target", "for", "parent", "block"]);
        if (target) referenced.add(target);
        const action = readFirstStringAttr(node, ["action", "type"])?.toLowerCase();
        if (action) {
          if (action !== "insert" && action !== "delete" && action !== "replace") {
            diagnostics.push({
              severity: "warning",
              code: "change-request-invalid-action",
              message: `change_request "${node.id ?? "?"}" action="${action}" must be insert, delete, or replace.`,
              pos: node.pos,
              nodeId: node.id
            });
          } else if (!hasChangeRequestRevisionText(node, action)) {
            diagnostics.push({
              severity: "warning",
              code: "change-request-missing-revision-text",
              message: `change_request "${node.id ?? "?"}" action="${action}" is missing the text needed for a tracked revision.`,
              pos: node.pos,
              nodeId: node.id
            });
          }
        }
      }
      if ((node.name === "footnote" || node.name === "endnote") && !suppressed(node)) {
        const target = readFirstStringAttr(node, ["target", "for", "parent", "block", "ref"]);
        if (target) referenced.add(target);
      }
      if (node.name === "evidence" || node.name === "counterevidence") {
        const target = node.attrs.for;
        if (typeof target === "string") {
          referenced.add(target);
          evidenceTargets.add(target);
        } else {
          diagnostics.push({
            severity: "warning",
            code: "evidence-missing-for",
            message: `${node.name} block has no \`for=\` attribute.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
      }
      if (node.name === "diagram" && !suppressed(node)) {
        const kind = String(node.attrs.kind ?? "");
        if (!kind) {
          diagnostics.push({
            severity: "warning",
            code: "diagram-missing-kind",
            message: `Diagram "${node.id ?? "?"}" has no \`kind=\` (mermaid|graphviz|drawio).`,
            pos: node.pos,
            nodeId: node.id
          });
        }
        if (!(node.body && node.body.trim())) {
          diagnostics.push({
            severity: "warning",
            code: "diagram-missing-source",
            message: `Diagram "${node.id ?? "?"}" has no source body.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
      }
      if (node.name === "plotly" && !suppressed(node)) {
        const body = (node.body ?? "").trim();
        if (!body) {
          diagnostics.push({
            severity: "warning",
            code: "plotly-missing-spec",
            message: `Plotly "${node.id ?? "?"}" has no JSON spec body.`,
            pos: node.pos,
            nodeId: node.id
          });
        } else {
          try {
            JSON.parse(body);
          } catch (e) {
            diagnostics.push({
              severity: "error",
              code: "plotly-invalid-json",
              message: `Plotly "${node.id ?? "?"}" body is not valid JSON: ${e.message}`,
              pos: node.pos,
              nodeId: node.id
            });
          }
        }
      }
      if (node.name === "figure" && !suppressed(node) && !node.attrs.alt && !node.attrs.caption) {
        diagnostics.push({
          severity: "warning",
          code: "figure-missing-alt",
          message: `Figure block has no alt or caption text.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if (node.name === "plot") {
        const hasData = "data" in node.attrs || "dataset" in node.attrs;
        if (typeof node.attrs.dataset === "string") {
          const ref = node.attrs.dataset;
          if (!datasetIds.has(ref)) {
            diagnostics.push({
              severity: "error",
              code: "plot-unknown-dataset",
              message: `Plot "${node.id ?? "?"}" references unknown dataset "${ref}".`,
              pos: node.pos,
              nodeId: node.id
            });
          } else if (typeof node.attrs.column === "string") {
            const cols = datasetColumns.get(ref) ?? /* @__PURE__ */ new Set();
            if (cols.size > 0 && !cols.has(node.attrs.column)) {
              diagnostics.push({
                severity: "error",
                code: "plot-unknown-column",
                message: `Plot "${node.id ?? "?"}" references unknown column "${node.attrs.column}" in dataset "${ref}".`,
                pos: node.pos,
                nodeId: node.id
              });
            }
          }
        }
        if (!hasData) {
          diagnostics.push({
            severity: "error",
            code: "plot-missing-data",
            message: `Plot has no data or dataset attribute.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
        if (!suppressed(node)) {
          const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
          const labels = typeof node.attrs.xlabels === "string" ? node.attrs.xlabels : "";
          const delim = (s) => {
            const hasComma = /,/.test(s);
            const hasSpace = /\s/.test(s.trim());
            if (hasComma && !hasSpace) return "comma";
            if (hasSpace && !hasComma) return "space";
            return null;
          };
          const a = delim(data);
          const b = delim(labels);
          if (a && b && a !== b) {
            diagnostics.push({
              severity: "warning",
              code: "plot-mixed-delimiters",
              message: `Plot "${node.id ?? "?"}" mixes ${a}-separated data with ${b}-separated xlabels. Use commas for both (preferred).`,
              pos: node.pos,
              nodeId: node.id
            });
          }
        }
      }
      if (node.name === "risk" && !suppressed(node) && !node.attrs.owner) {
        diagnostics.push({
          severity: "warning",
          code: "risk-without-owner",
          message: `Risk "${node.id ?? "?"}" has no \`owner=\` attribute.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if ((node.name === "decision" || node.name === "adr") && !suppressed(node) && !node.attrs.status) {
        diagnostics.push({
          severity: "warning",
          code: "decision-without-status",
          message: `${node.name} "${node.id ?? "?"}" has no \`status=\` attribute.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if ((node.name === "agent_task" || node.name === "todo") && !suppressed(node) && !node.attrs.scope && !(node.body && node.body.trim().length > 0) && node.children.length === 0) {
        diagnostics.push({
          severity: "warning",
          code: "agent-task-without-scope",
          message: `Agent task "${node.id ?? "?"}" has no scope or body.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if ((node.name === "html" || node.name === "svg" || node.name === "script") && !suppressed(node) && node.attrs.trusted !== true) {
        diagnostics.push({
          severity: "warning",
          code: "escape-hatch-untrusted",
          message: `${node.name} escape-hatch block has no \`trusted\` attribute. Add \`trusted\` to silence this warning, or \`noverify\` to suppress all checks on this block.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if (node.name === "memory" && !suppressed(node)) {
        const t = node.attrs.type;
        if (typeof t !== "string" || !t) {
          diagnostics.push({
            severity: "error",
            code: "memory-missing-type",
            message: `Memory "${node.id ?? "?"}" has no \`type=\` attribute.`,
            pos: node.pos,
            nodeId: node.id
          });
        } else if (!MEMORY_TYPES.has(t)) {
          diagnostics.push({
            severity: "error",
            code: "memory-invalid-type",
            message: `Memory "${node.id ?? "?"}" has type="${t}". Must be one of: ${[...MEMORY_TYPES].join(", ")}.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
        if ("confidence" in node.attrs) {
          const c = node.attrs.confidence;
          let num = null;
          if (typeof c === "number" && Number.isFinite(c)) {
            num = c;
          } else if (typeof c === "string" && c.trim() !== "") {
            const n = Number(c);
            if (Number.isFinite(n)) num = n;
          }
          if (num === null || num < 0 || num > 1) {
            diagnostics.push({
              severity: "error",
              code: "memory-invalid-confidence",
              message: `Memory "${node.id ?? "?"}" confidence="${c}" must be a number in [0, 1].`,
              pos: node.pos,
              nodeId: node.id
            });
          }
        }
        if ("last_seen" in node.attrs) {
          const ls = node.attrs.last_seen;
          const s = typeof ls === "string" ? ls : "";
          if (!s || !ISO_DATE_RE.test(s) || !isValidIsoDate(s)) {
            diagnostics.push({
              severity: "error",
              code: "memory-invalid-last-seen",
              message: `Memory "${node.id ?? "?"}" last_seen="${ls}" must be ISO date (YYYY-MM-DD or full ISO 8601).`,
              pos: node.pos,
              nodeId: node.id
            });
          }
        }
        if (!node.id) {
          diagnostics.push({
            severity: "error",
            code: "memory-missing-id",
            message: `Memory block has no \`id=\` attribute.`,
            pos: node.pos
          });
        }
      }
      if (node.name === "citation" && !suppressed(node)) {
        if (!node.attrs.url && !node.attrs.source && !node.attrs.doi) {
          diagnostics.push({
            severity: "warning",
            code: "citation-missing-source",
            message: `Citation "${node.id ?? "?"}" has no \`url=\`, \`source=\`, or \`doi=\` attribute.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
        if (node.attrs.accessed) {
          const perBlock = readPositiveNumber(node.attrs.stale_after_days);
          const window2 = perBlock ?? staleDays;
          const stale = isStale2(String(node.attrs.accessed), now, window2);
          if (stale) {
            diagnostics.push({
              severity: "warning",
              code: "stale-citation",
              message: `Citation "${node.id ?? "?"}" was last accessed ${node.attrs.accessed} (>${window2} days ago).`,
              pos: node.pos,
              nodeId: node.id
            });
          }
        }
      }
    }
    for (const target of referenced) {
      if (!ids.has(target) && !aliasIds.has(target)) {
        diagnostics.push({
          severity: "error",
          code: "broken-reference",
          message: `Reference to unknown block ID "${target}".`
        });
      }
    }
    if (declaredProfiles.includes("memory")) {
      for (const target of wikilinkRefs) {
        const node = ids.get(target) ?? aliasToNode.get(target);
        if (!node) continue;
        const isMemory = node.type === "directive" && node.name === "memory";
        if (!isMemory) {
          diagnostics.push({
            severity: "warning",
            code: "memory-wikilink-non-memory-target",
            message: `Wikilink [[${target}]] points at a non-::memory block. Memory profile expects wikilinks to resolve to ::memory directives.`
          });
        }
      }
    }
    if (requireEvidence) {
      for (const claim of claims) {
        if (suppressed(claim)) continue;
        if (claim.id && !evidenceTargets.has(claim.id)) {
          diagnostics.push({
            severity: "warning",
            code: "claim-without-evidence",
            message: `Claim "${claim.id}" has no evidence backing it.`,
            pos: claim.pos,
            nodeId: claim.id
          });
        }
      }
    }
    validateComputedNodes(computedNodes, controls, computed, diagnostics);
    const ignore = options.ignoreRules;
    if (ignore && ignore.length > 0) {
      const known = collectRuleCodes();
      for (const rule of ignore) {
        if (!known.has(rule)) {
          diagnostics.push({
            severity: "info",
            code: "unknown-ignore-rule",
            message: `--ignore-rule "${rule}" matches no known validator rule (ignored).`
          });
        }
      }
      const set2 = new Set(ignore);
      return diagnostics.filter((d) => !set2.has(d.code));
    }
    return diagnostics;
  }
  function readDeclaredProfiles(meta) {
    if (Array.isArray(meta.profiles)) {
      const out = [];
      for (const p of meta.profiles) {
        if (typeof p === "string" && p.trim()) out.push(p.trim());
      }
      if (out.length > 0) return out;
    }
    if (typeof meta.profile === "string" && meta.profile.trim()) {
      return [meta.profile.trim()];
    }
    return [];
  }
  var KNOWN_RULES = [
    "duplicate-id",
    "out-of-profile-directive",
    "unknown-profile",
    "broken-reference",
    "evidence-missing-for",
    "figure-missing-alt",
    "plot-unknown-dataset",
    "plot-unknown-column",
    "plot-missing-data",
    "plot-mixed-delimiters",
    "risk-without-owner",
    "decision-without-status",
    "agent-task-without-scope",
    "escape-hatch-untrusted",
    "stale-citation",
    "claim-without-evidence",
    "state-change-missing-block",
    "state-change-missing-from-to",
    "change-request-invalid-action",
    "change-request-missing-revision-text",
    "diagram-missing-kind",
    "diagram-missing-source",
    "plotly-missing-spec",
    "plotly-invalid-json",
    "dataset-src-missing",
    "memory-missing-type",
    "memory-invalid-type",
    "memory-invalid-confidence",
    "memory-invalid-last-seen",
    "memory-missing-id",
    "memory-wikilink-non-memory-target",
    "claim-invalid-confidence",
    "citation-missing-source",
    "control-missing-default",
    "control-out-of-range-default",
    "control-invalid-lock",
    "computed-missing-formula",
    "computed-unknown-dependency",
    "formula-parse-error",
    "computed-chain-too-deep"
  ];
  function collectRuleCodes() {
    return new Set(KNOWN_RULES);
  }
  function suppressed(node) {
    return node.attrs.noverify === true;
  }
  function readFirstStringAttr(node, keys) {
    for (const key of keys) {
      const value = node.attrs[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return void 0;
  }
  function hasChangeRequestRevisionText(node, action) {
    const from = readFirstStringAttr(node, ["from"]);
    const to = readFirstStringAttr(node, ["to"]);
    const text = readFirstStringAttr(node, ["text"]);
    const body = Boolean((node.body ?? "").trim() || node.children.length > 0);
    if (action === "replace") return Boolean(from && to);
    if (action === "insert") return Boolean(to || text || body);
    return Boolean(from || text || body);
  }
  function validateControl(node, diagnostics) {
    if (!controlNeedsNumericDefault(node)) return;
    const def = controlDefaultNumber(node);
    if (def === void 0) {
      diagnostics.push({
        severity: "warning",
        code: "control-missing-default",
        message: `Numeric control "${node.id ?? "?"}" has no numeric \`default=\` value for static rendering and LLM context.`,
        pos: node.pos,
        nodeId: node.id
      });
      return;
    }
    const min = numericAttr(node.attrs, "min");
    const max = numericAttr(node.attrs, "max");
    if (min !== void 0 && def < min || max !== void 0 && def > max) {
      diagnostics.push({
        severity: "warning",
        code: "control-out-of-range-default",
        message: `Numeric control "${node.id ?? "?"}" default=${def} is outside its declared range.`,
        pos: node.pos,
        nodeId: node.id
      });
    }
  }
  function validateControlLock(node, diagnostics) {
    const value = node.attrs.lock ?? node.attrs.content_control_lock ?? node.attrs.sdt_lock;
    if (value === void 0 || typeof value === "boolean") return;
    const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (CONTROL_LOCK_VALUES.has(normalized)) return;
    diagnostics.push({
      severity: "warning",
      code: "control-invalid-lock",
      message: `Control "${node.id ?? "?"}" lock="${value}" must be control, content, all, unlocked, or none.`,
      pos: node.pos,
      nodeId: node.id
    });
  }
  var CONTROL_LOCK_VALUES = /* @__PURE__ */ new Set([
    "control",
    "field",
    "container",
    "sdt",
    "sdtlocked",
    "content",
    "value",
    "contentlocked",
    "all",
    "both",
    "full",
    "sdtcontentlocked",
    "controlandcontent",
    "fieldandcontent",
    "unlocked",
    "none",
    "off",
    "false",
    "0",
    "no",
    ""
  ]);
  function controlNeedsNumericDefault(node) {
    const type2 = typeof node.attrs.type === "string" ? node.attrs.type.trim().toLowerCase() : void 0;
    if (!type2) return true;
    return type2 === "slider" || type2 === "range" || type2 === "number" || type2 === "checkbox" || type2 === "toggle";
  }
  function validateComputedNodes(nodes, controls, computed, diagnostics) {
    const depMap = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      if (suppressed(node)) continue;
      const formula = formulaText(node);
      if (!formula) {
        diagnostics.push({
          severity: "warning",
          code: "computed-missing-formula",
          message: `${node.name} "${node.id ?? "?"}" has no \`formula=\` attribute or \`formula:\` body line.`,
          pos: node.pos,
          nodeId: node.id
        });
        continue;
      }
      const parsed = parseFormula(formula);
      if (!parsed.ok) {
        diagnostics.push({
          severity: "error",
          code: "formula-parse-error",
          message: `${node.name} "${node.id ?? "?"}" formula could not be parsed: ${parsed.error.message}`,
          pos: node.pos,
          nodeId: node.id
        });
        continue;
      }
      const domainVars = computedDomainVars(node);
      const deps = extractFormulaIdentifiers(parsed.ast);
      depMap.set(node.id ?? `@${node.pos?.line ?? depMap.size}`, deps);
      for (const dep of deps) {
        if (domainVars.has(dep) || controls.has(dep) || computed.has(dep)) continue;
        diagnostics.push({
          severity: "error",
          code: "computed-unknown-dependency",
          message: `${node.name} "${node.id ?? "?"}" formula references unknown control or computed block "${dep}".`,
          pos: node.pos,
          nodeId: node.id
        });
      }
    }
    const depthMemo = /* @__PURE__ */ new Map();
    const visiting = /* @__PURE__ */ new Set();
    const depthOf = (id) => {
      if (controls.has(id)) return 0;
      const memo = depthMemo.get(id);
      if (memo !== void 0) return memo;
      if (visiting.has(id)) return Infinity;
      const node = computed.get(id);
      if (!node) return 0;
      visiting.add(id);
      const deps = depMap.get(id) ?? [];
      let depth = 1;
      for (const dep of deps) {
        if (computed.has(dep)) depth = Math.max(depth, depthOf(dep) + 1);
      }
      visiting.delete(id);
      depthMemo.set(id, depth);
      return depth;
    };
    for (const node of nodes) {
      if (suppressed(node) || !node.id) continue;
      const depth = depthOf(node.id);
      if (depth > 2) {
        diagnostics.push({
          severity: "warning",
          code: "computed-chain-too-deep",
          message: `${node.name} "${node.id}" has computed dependency depth ${depth === Infinity ? "cycle" : depth}; keep computed chains at depth <= 2.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
    }
  }
  function readDatasetColumns(node) {
    const cols = /* @__PURE__ */ new Set();
    if (typeof node.attrs.columns === "string") {
      for (const c of node.attrs.columns.split(/[,\s]+/).filter(Boolean)) cols.add(c);
    }
    const body = node.body ?? "";
    const format = String(node.attrs.format ?? "").toLowerCase();
    if (!body.trim()) return cols;
    if (format === "csv" || format === "tsv") {
      const delim = format === "tsv" ? "	" : ",";
      const firstLine = body.replace(/\r\n?/g, "\n").split("\n").find((l) => l.length > 0);
      if (firstLine) {
        for (const c of splitDelimitedRow(firstLine, delim).filter(Boolean)) {
          cols.add(c);
        }
      }
      return cols;
    }
    if (format === "json") {
      try {
        const parsed2 = JSON.parse(body);
        if (Array.isArray(parsed2) && parsed2.length > 0) {
          const head = parsed2[0];
          if (head && typeof head === "object" && !Array.isArray(head)) {
            for (const k of Object.keys(head)) cols.add(k);
          }
        } else if (parsed2 && typeof parsed2 === "object" && Array.isArray(parsed2.columns)) {
          for (const c of parsed2.columns) {
            if (typeof c === "string") cols.add(c);
          }
        }
      } catch {
      }
      return cols;
    }
    let parsed;
    try {
      parsed = jsYaml.load(body);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const schema2 = parsed.schema;
      if (schema2 && typeof schema2 === "object" && !Array.isArray(schema2)) {
        for (const k of Object.keys(schema2)) cols.add(k);
      }
    }
    return cols;
  }
  function readPositiveNumber(v) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return void 0;
  }
  function isValidIsoDate(s) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return false;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return true;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }
  function isStale2(accessed, now, days) {
    const t = Date.parse(accessed);
    if (Number.isNaN(t)) return false;
    const ageMs = now.getTime() - t;
    return ageMs > days * 24 * 60 * 60 * 1e3;
  }

  // themes/default.css
  var default_default = ':root {\n  --noma-bg: #fbfaf7;\n  --noma-fg: #1d1c1a;\n  --noma-muted: #6b6a66;\n  --noma-rule: #e7e4dc;\n  --noma-accent: #b9522a;\n  --noma-accent-soft: #f4dccd;\n  --noma-claim: #2c5d8f;\n  --noma-claim-soft: #dfeaf5;\n  --noma-evidence: #2f7d4a;\n  --noma-evidence-soft: #dff0e3;\n  --noma-risk: #a8362e;\n  --noma-risk-soft: #f7d9d4;\n  --noma-code-bg: #f1ede4;\n  --noma-card-bg: #ffffff;\n  --noma-shadow: 0 1px 0 rgba(0, 0, 0, 0.04), 0 8px 24px -16px rgba(20, 20, 20, 0.18);\n  --noma-radius: 8px;\n  --noma-cols: 2;\n  --noma-grid-min: 14rem;\n  --noma-grid-gap: 1rem;\n  --noma-font-serif: "Iowan Old Style", "Charter", Georgia, serif;\n  --noma-font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;\n  --noma-font-mono: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;\n}\n\n* { box-sizing: border-box; }\n\nhtml, body {\n  margin: 0;\n  padding: 0;\n  background: var(--noma-bg);\n  color: var(--noma-fg);\n  font-family: var(--noma-font-serif);\n  font-size: 16px;\n  line-height: 1.58;\n  -webkit-font-smoothing: antialiased;\n  text-rendering: optimizeLegibility;\n}\n\nmain.noma-doc {\n  max-width: 1040px;\n  margin: 3rem auto;\n  padding: 0 1.25rem 5rem;\n}\n\nmain.noma-doc > section.noma-hero ~ section,\nmain.noma-doc > .noma-grid,\nmain.noma-doc > .noma-columns {\n  max-width: 100%;\n}\n\nh1, h2, h3, h4, h5, h6 {\n  font-family: var(--noma-font-sans);\n  font-weight: 700;\n  line-height: 1.2;\n  letter-spacing: 0;\n  margin: 2em 0 0.55em;\n}\nh1 { font-size: 2.1rem; margin-top: 0; }\nh2 { font-size: 1.45rem; border-bottom: 1px solid var(--noma-rule); padding-bottom: 0.25em; }\nh3 { font-size: 1.15rem; }\nh4 { font-size: 0.98rem; color: var(--noma-muted); text-transform: uppercase; letter-spacing: 0.04em; }\n\np { margin: 0 0 1.05em; }\na { color: var(--noma-accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }\na:hover { text-decoration-thickness: 2px; }\n\ncode {\n  font-family: var(--noma-font-mono);\n  font-size: 0.9em;\n  background: var(--noma-code-bg);\n  padding: 0.1em 0.35em;\n  border-radius: 4px;\n}\npre {\n  background: var(--noma-code-bg);\n  padding: 1em 1.2em;\n  border-radius: var(--noma-radius);\n  overflow-x: auto;\n  font-size: 0.9rem;\n  line-height: 1.5;\n}\npre code { background: none; padding: 0; }\n\nblockquote {\n  border-left: 3px solid var(--noma-accent);\n  margin: 1.5em 0;\n  padding: 0.2em 1.2em;\n  color: var(--noma-muted);\n  font-style: italic;\n}\n\nhr { border: 0; border-top: 1px solid var(--noma-rule); margin: 3em 0; }\n\nul, ol { padding-left: 1.4em; }\nli { margin: 0.25em 0; }\n\nfigure {\n  margin: 1.8em 0;\n}\nfigure img {\n  display: block;\n  max-width: 100%;\n  height: auto;\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\nfigcaption {\n  margin-top: 0.65em;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n\n/* Callouts */\naside.noma-callout {\n  margin: 1.6em 0;\n  padding: 1em 1.2em;\n  border-radius: var(--noma-radius);\n  background: var(--noma-accent-soft);\n  border-left: 3px solid var(--noma-accent);\n}\naside.noma-callout-warning { background: #fbe6df; border-color: var(--noma-risk); }\naside.noma-callout-tip     { background: #e6f3eb; border-color: var(--noma-evidence); }\naside.noma-callout-note    { background: #ecedf2; border-color: #5a6071; }\n\n/* Research blocks */\naside.noma-research {\n  margin: 1.6em 0;\n  padding: 1em 1.2em;\n  border-radius: var(--noma-radius);\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  box-shadow: var(--noma-shadow);\n}\naside.noma-research .noma-research-head {\n  display: flex;\n  align-items: center;\n  gap: 0.8em;\n  margin-bottom: 0.5em;\n}\naside.noma-research .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--noma-muted);\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: var(--noma-code-bg);\n}\naside.noma-claim          { border-left: 3px solid var(--noma-claim); }\naside.noma-claim .noma-tag { color: var(--noma-claim); background: var(--noma-claim-soft); }\naside.noma-evidence       { border-left: 3px solid var(--noma-evidence); }\naside.noma-evidence .noma-tag { color: var(--noma-evidence); background: var(--noma-evidence-soft); }\naside.noma-counterevidence { border-left: 3px solid var(--noma-risk); }\naside.noma-counterevidence .noma-tag { color: var(--noma-risk); background: var(--noma-risk-soft); }\naside.noma-risk           { border-left: 3px solid var(--noma-risk); }\naside.noma-risk .noma-tag  { color: var(--noma-risk); background: var(--noma-risk-soft); }\naside.noma-decision, aside.noma-adr { border-left: 3px solid var(--noma-accent); }\naside.noma-decision .noma-tag, aside.noma-adr .noma-tag { color: var(--noma-accent); background: var(--noma-accent-soft); }\naside.noma-open_question { border-left: 3px solid #8b6c1a; }\naside.noma-open_question .noma-tag { color: #8b6c1a; background: #f5ebcf; }\naside.noma-assumption { border-left: 3px solid #5a6071; }\naside.noma-assumption .noma-tag { color: #5a6071; background: #ecedf2; }\n\n/* Variants \u2014 themable per-block emphasis without inline styling */\n[data-variant="important"] { border-width: 5px !important; box-shadow: 0 0 0 1px var(--noma-accent) inset, var(--noma-shadow); }\n[data-variant="subtle"] { opacity: 0.78; box-shadow: none; }\n[data-variant="success"] { border-left: 3px solid var(--noma-evidence); background: var(--noma-evidence-soft); }\n[data-variant="danger"]  { border-left: 3px solid var(--noma-risk); background: var(--noma-risk-soft); }\n[data-variant="info"]    { border-left: 3px solid var(--noma-claim); background: var(--noma-claim-soft); }\n\n/* Export buttons (artifact-side action surface) */\n.noma-export-button {\n  display: inline-block;\n  background: var(--noma-fg);\n  color: var(--noma-bg);\n  border: 0;\n  padding: 0.55em 1.1em;\n  margin: 0.3em 0.4em 0.3em 0;\n  border-radius: 999px;\n  font-family: var(--noma-font-sans);\n  font-weight: 600;\n  font-size: 0.85rem;\n  cursor: pointer;\n  transition: background 120ms ease;\n}\n.noma-export-button:hover { background: var(--noma-accent); color: white; }\n.noma-export-button[data-format="prompt"] { background: var(--noma-claim); }\n.noma-export-button[data-format="markdown"] { background: var(--noma-evidence); }\n.noma-export-button[data-format="json"] { background: var(--noma-muted); }\n\n/* Controls (interactive artifact blocks) */\n.noma-control {\n  margin: 1em 0;\n  padding: 0.8em 1em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n.noma-control-row {\n  display: grid;\n  grid-template-columns: minmax(9rem, 1fr) minmax(8rem, 2fr);\n  gap: 0.75rem;\n  align-items: center;\n}\n.noma-control-label { font-weight: 650; }\n.noma-control input,\n.noma-control select {\n  width: 100%;\n  accent-color: var(--noma-accent);\n  font: inherit;\n}\n.noma-control input[type="number"],\n.noma-control input[type="text"],\n.noma-control select {\n  border: 1px solid var(--noma-rule);\n  border-radius: 6px;\n  padding: 0.35em 0.5em;\n  background: var(--noma-bg);\n  color: var(--noma-fg);\n}\n.noma-control input[type="checkbox"] {\n  width: auto;\n  justify-self: start;\n}\n.noma-control-value {\n  display: block;\n  margin-top: 0.35rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-mono);\n  font-size: 0.82rem;\n}\n.noma-interactive-disabled {\n  display: inline-block;\n  margin-bottom: 0.5rem;\n  padding: 0.18em 0.55em;\n  border: 1px solid var(--noma-rule);\n  border-radius: 999px;\n  color: var(--noma-muted);\n  background: var(--noma-bg);\n  font-family: var(--noma-font-sans);\n  font-size: 0.72rem;\n  font-weight: 650;\n}\n\n.noma-computed {\n  margin: 1.2em 0;\n  padding: 1em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 4px solid var(--noma-claim);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\n.noma-computed-head {\n  display: flex;\n  gap: 0.8rem;\n  align-items: baseline;\n  flex-wrap: wrap;\n  margin-bottom: 0.45rem;\n}\n.noma-computed-head h3 {\n  margin: 0;\n  font-size: 1rem;\n}\n.noma-computed-value {\n  font-family: var(--noma-font-sans);\n  font-size: 1.75rem;\n  line-height: 1.15;\n  font-weight: 750;\n  color: var(--noma-claim);\n}\n.noma-computed-body {\n  margin-top: 0.75rem;\n}\n.noma-computed-body p {\n  margin-bottom: 0;\n}\n.noma-computed-plot {\n  padding: 1em;\n}\n.noma-computed-canvas {\n  margin-bottom: 0.5rem;\n}\n.noma-computed-table-view {\n  margin: 0.65rem 0 0;\n  font-size: 0.9rem;\n}\n.noma-computed-table-view th:last-child,\n.noma-computed-table-view td:last-child {\n  text-align: right;\n}\n@media (max-width: 720px) {\n  .noma-control-row {\n    grid-template-columns: 1fr;\n  }\n}\n\n.noma-confidence {\n  flex: 1;\n  height: 6px;\n  border-radius: 999px;\n  background: var(--noma-rule);\n  overflow: hidden;\n  max-width: 140px;\n}\n.noma-confidence-bar {\n  height: 100%;\n  background: linear-gradient(90deg, var(--noma-accent), var(--noma-claim));\n}\n\n.noma-meta {\n  margin-top: 0.6em;\n  font-size: 0.85rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n}\n.noma-meta-key {\n  font-weight: 600;\n  color: var(--noma-fg);\n}\n\n/* Grid */\n.noma-grid,\n.noma-columns {\n  display: grid;\n  grid-template-columns: repeat(var(--noma-cols), minmax(0, 1fr));\n  gap: var(--noma-grid-gap);\n  margin: 1.5em 0;\n}\n.noma-grid-auto,\n.noma-columns-auto {\n  grid-template-columns: repeat(auto-fit, minmax(min(var(--noma-grid-min), 100%), 1fr));\n}\n.noma-grid-wide,\n.noma-columns-wide,\n.noma-grid-full,\n.noma-columns-full {\n  position: relative;\n  left: 50%;\n  transform: translateX(-50%);\n}\n.noma-grid-wide,\n.noma-columns-wide {\n  width: min(1180px, calc(100vw - 2rem));\n}\n.noma-grid-full,\n.noma-columns-full {\n  width: min(1440px, calc(100vw - 2rem));\n}\n.noma-grid-compact,\n.noma-columns-compact {\n  --noma-grid-gap: 0.75rem;\n}\n@media (max-width: 720px) {\n  .noma-grid,\n  .noma-columns {\n    grid-template-columns: 1fr;\n    width: auto;\n    left: auto;\n    transform: none;\n  }\n}\n\n/* Card */\narticle.noma-card {\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  padding: 1em 1.1em;\n  box-shadow: var(--noma-shadow);\n}\narticle.noma-card .noma-card-head {\n  display: flex;\n  align-items: center;\n  gap: 0.6em;\n  margin-bottom: 0.4em;\n}\narticle.noma-card h3 {\n  margin: 0;\n  font-size: 1rem;\n  font-family: var(--noma-font-sans);\n}\narticle.noma-card .noma-icon {\n  color: var(--noma-accent);\n  font-size: 0.9em;\n}\narticle.noma-card p:last-child { margin-bottom: 0; }\n\n/* Hero */\nsection.noma-hero {\n  background: linear-gradient(180deg, var(--noma-accent-soft), transparent);\n  padding: 3rem 2rem 2.4rem;\n  border-radius: var(--noma-radius);\n  margin: 0 0 3rem;\n  text-align: center;\n}\nsection.noma-hero h1 { font-size: 2.8rem; margin-top: 0; }\n\na.noma-button {\n  display: inline-block;\n  background: var(--noma-fg);\n  color: var(--noma-bg);\n  padding: 0.7em 1.4em;\n  border-radius: 999px;\n  text-decoration: none;\n  font-family: var(--noma-font-sans);\n  font-weight: 600;\n  font-size: 0.95rem;\n  margin-top: 0.5em;\n}\na.noma-button:hover { background: var(--noma-accent); color: white; }\n\n/* Plot */\nfigure.noma-plot {\n  margin: 1.8em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n}\nfigure.noma-plot .noma-plot-canvas {\n  color: var(--noma-claim);\n  background: linear-gradient(180deg, transparent, var(--noma-claim-soft));\n  border-radius: 6px;\n  padding: 0.6em;\n}\nfigure.noma-plot svg { width: 100%; height: auto; display: block; }\nfigure.noma-plot figcaption {\n  margin-top: 0.6em;\n  font-size: 0.85rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n}\nfigure.noma-plot[data-compact="true"] {\n  padding: 0.65em 0.8em;\n}\nfigure.noma-plot[data-compact="true"] figcaption {\n  margin-top: 0.35em;\n  font-size: 0.78rem;\n}\n\n/* Dataset */\ndetails.noma-dataset {\n  margin: 1.4em 0;\n  padding: 0.6em 1em;\n  background: var(--noma-code-bg);\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\ndetails.noma-dataset pre {\n  background: transparent;\n  padding: 0.6em 0 0;\n}\n\n/* Agent task */\n.noma-agent-task {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-claim-soft);\n  border-left: 3px solid var(--noma-claim);\n  border-radius: var(--noma-radius);\n}\n.noma-agent-task label {\n  display: flex;\n  align-items: center;\n  gap: 0.6em;\n  font-family: var(--noma-font-sans);\n  font-weight: 600;\n  font-size: 0.9rem;\n  margin-bottom: 0.4em;\n}\n\n/* Collaboration metadata */\naside.noma-comment,\naside.noma-review-meta {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid #5a6071;\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\naside.noma-comment {\n  background: #f7f6f1;\n}\n.noma-comment-head,\n.noma-review-meta-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.55em;\n  margin-bottom: 0.4em;\n  font-family: var(--noma-font-sans);\n}\n.noma-comment .noma-tag,\n.noma-review-meta .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: #5a6071;\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: #ecedf2;\n}\n.noma-review-meta.noma-collab-review {\n  border-left-color: var(--noma-accent);\n}\n.noma-review-meta.noma-collab-review .noma-tag {\n  color: var(--noma-accent);\n  background: var(--noma-accent-soft);\n}\n.noma-review-meta.noma-collab-provenance {\n  border-left-color: var(--noma-claim);\n}\n.noma-review-meta.noma-collab-provenance .noma-tag {\n  color: var(--noma-claim);\n  background: var(--noma-claim-soft);\n}\n.noma-review-meta.noma-collab-confidence {\n  border-left-color: var(--noma-evidence);\n}\n.noma-review-meta.noma-collab-confidence .noma-tag {\n  color: var(--noma-evidence);\n  background: var(--noma-evidence-soft);\n}\n.noma-comment-body p:last-child,\n.noma-review-meta-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Memory profile */\naside.noma-memory,\naside.noma-memory-index {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid #5a6071;\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\naside.noma-memory-index {\n  background: #f4f7f8;\n}\n.noma-memory-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.4em;\n  font-family: var(--noma-font-sans);\n}\n.noma-memory .noma-tag,\n.noma-memory-index .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0;\n  text-transform: uppercase;\n  color: #5a6071;\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: #ecedf2;\n}\n.noma-memory h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-memory.noma-memory-user {\n  border-left-color: var(--noma-evidence);\n}\n.noma-memory.noma-memory-user .noma-tag {\n  color: var(--noma-evidence);\n  background: var(--noma-evidence-soft);\n}\n.noma-memory.noma-memory-feedback {\n  border-left-color: var(--noma-accent);\n}\n.noma-memory.noma-memory-feedback .noma-tag {\n  color: var(--noma-accent);\n  background: var(--noma-accent-soft);\n}\n.noma-memory.noma-memory-project {\n  border-left-color: var(--noma-claim);\n}\n.noma-memory.noma-memory-project .noma-tag {\n  color: var(--noma-claim);\n  background: var(--noma-claim-soft);\n}\n.noma-memory.noma-memory-reference {\n  border-left-color: #5a6071;\n}\n.noma-memory.noma-memory-reference .noma-tag {\n  color: #5a6071;\n  background: #ecedf2;\n}\n.noma-memory-body p:last-child,\n.noma-memory-index .noma-memory-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Metrics */\naside.noma-metric {\n  margin: 1.5em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid var(--noma-evidence);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\n.noma-metric-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.25em;\n}\n.noma-metric .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--noma-evidence);\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: var(--noma-evidence-soft);\n}\n.noma-metric h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-metric-value {\n  margin: 0.2em 0 0.25em;\n  color: var(--noma-evidence);\n  font-family: var(--noma-font-sans);\n  font-size: 1.7rem;\n  font-weight: 800;\n  line-height: 1.15;\n}\n.noma-metric-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Technical documentation */\narticle.noma-technical {\n  margin: 1.5em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid var(--noma-claim);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\narticle.noma-technical .noma-technical-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.35em;\n}\narticle.noma-technical .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--noma-claim);\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: var(--noma-claim-soft);\n}\narticle.noma-technical h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-technical-meta {\n  margin: 0.35em 0 0.65em;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.85rem;\n}\n.noma-technical-body p:last-child {\n  margin-bottom: 0;\n}\npre.noma-technical-code {\n  margin: 0.7em 0 0;\n}\n\n/* Custom directives */\naside.noma-block {\n  margin: 1.5em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid #5a6071;\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\n.noma-block-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.35em;\n  font-family: var(--noma-font-sans);\n}\naside.noma-block .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0;\n  text-transform: uppercase;\n  color: #5a6071;\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: #ecedf2;\n}\naside.noma-block h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-block-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Change requests */\naside.noma-change-request {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: #fff4f0;\n  border: 1px solid #f0c7bd;\n  border-left: 3px solid #c85c4a;\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n}\n.noma-change-request-head {\n  font-size: 0.85rem;\n  color: var(--noma-muted, var(--noma-fg));\n  margin-bottom: 0.45em;\n}\n.noma-change-request-delta {\n  display: flex;\n  align-items: baseline;\n  gap: 0.55em;\n  margin: 0.35em 0 0.55em;\n  line-height: 1.5;\n}\n.noma-change-request del {\n  color: #9a382b;\n  text-decoration-thickness: 0.12em;\n}\n.noma-change-request ins {\n  color: #2f6e42;\n  font-weight: 700;\n  text-decoration: none;\n}\n\n/* State change */\naside.noma-state-change {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid var(--noma-fg);\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n}\n.noma-state-change-head {\n  font-size: 0.85rem;\n  letter-spacing: 0.02em;\n  color: var(--noma-muted, var(--noma-fg));\n  margin-bottom: 0.4em;\n  display: flex;\n  align-items: center;\n  gap: 0.5em;\n  flex-wrap: wrap;\n}\n.noma-state-change-delta {\n  font-size: 1rem;\n  display: flex;\n  align-items: baseline;\n  gap: 0.6em;\n  margin: 0.3em 0 0.5em;\n  font-variant-numeric: tabular-nums;\n}\n.noma-state-from {\n  text-decoration: line-through;\n  opacity: 0.65;\n}\n.noma-state-to {\n  font-weight: 700;\n}\n.noma-state-arrow {\n  opacity: 0.55;\n  font-size: 0.95em;\n}\n\n/* Tables */\ntable.noma-table {\n  width: 100%;\n  border-collapse: collapse;\n  margin: 1.6em 0;\n  font-family: var(--noma-font-sans);\n  font-size: 0.88rem;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  overflow: hidden;\n  box-shadow: var(--noma-shadow);\n}\ntable.noma-table thead {\n  background: var(--noma-code-bg);\n}\ntable.noma-table th {\n  text-align: left;\n  font-weight: 700;\n  letter-spacing: 0.02em;\n  padding: 0.55em 0.75em;\n  border-bottom: 1px solid var(--noma-rule);\n  color: var(--noma-fg);\n}\ntable.noma-table td {\n  padding: 0.5em 0.75em;\n  border-bottom: 1px solid var(--noma-rule);\n  vertical-align: top;\n}\ntable.noma-table tbody tr:last-child td { border-bottom: 0; }\ntable.noma-table tbody tr:hover { background: rgba(185, 82, 42, 0.04); }\n\n.noma-page-header,\n.noma-page-footer {\n  margin: 1.2rem 0;\n  padding: 0.55rem 0;\n  border-color: var(--noma-rule);\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n.noma-page-header {\n  border-bottom: 1px solid var(--noma-rule);\n}\n.noma-page-footer {\n  border-top: 1px solid var(--noma-rule);\n}\n.noma-page-header p,\n.noma-page-footer p {\n  margin: 0;\n}\n.noma-page-number {\n  display: block;\n  text-align: right;\n}\n\n.noma-toc {\n  margin: 1.6rem 0 2rem;\n  padding: 1rem 1.1rem;\n  border: 1px solid var(--noma-rule);\n  background: var(--noma-card-bg);\n  font-family: var(--noma-font-sans);\n  box-shadow: var(--noma-shadow);\n}\n.noma-toc h2 {\n  margin: 0 0 0.6rem;\n  padding: 0;\n  border: 0;\n  font-size: 1.1rem;\n}\n.noma-toc ol {\n  margin: 0;\n  padding: 0;\n  list-style: none;\n}\n.noma-toc li {\n  margin: 0.15rem 0;\n}\n.noma-toc li[data-level="2"] { margin-left: 1rem; }\n.noma-toc li[data-level="3"] { margin-left: 2rem; }\n.noma-toc li[data-level="4"] { margin-left: 3rem; }\n.noma-toc li[data-level="5"] { margin-left: 4rem; }\n.noma-toc li[data-level="6"] { margin-left: 5rem; }\n\n.noma-footnote,\n.noma-endnote {\n  margin: 1.2rem 0;\n  padding: 0.7rem 0.9rem;\n  border-left: 3px solid var(--noma-rule);\n  background: var(--noma-code-bg);\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n.noma-footnote p,\n.noma-endnote p {\n  margin: 0.25rem 0;\n}\n.noma-footnote sup,\n.noma-endnote sup {\n  margin-right: 0.4rem;\n  color: var(--noma-accent);\n  font-weight: 700;\n}\n\n.noma-bibliography {\n  margin: 2rem 0;\n  padding-top: 0.8rem;\n  border-top: 1px solid var(--noma-rule);\n}\n.noma-bibliography h2 {\n  margin-top: 0;\n}\n.noma-bibliography ol {\n  padding-left: 1.4rem;\n}\n.noma-citation-meta {\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9em;\n}\n\n.noma-pagebreak {\n  margin: 2rem 0;\n  border: 0;\n  border-top: 1px dashed var(--noma-rule);\n}\n\n/* Print */\n@media print {\n  @page { margin: 20mm 18mm; }\n  html, body { background: white; font-size: 11pt; }\n  main.noma-doc { margin: 0 auto; padding: 0; max-width: 100%; }\n  section.noma-hero { background: none; border: 1px solid var(--noma-rule); }\n  a { color: var(--noma-fg); }\n  pre, article.noma-card, article.noma-technical, aside.noma-block, .noma-computed, figure.noma-plot, figure.noma-plotly-wrap, figure.noma-diagram-wrap, aside.noma-research, aside.noma-comment, aside.noma-review-meta, aside.noma-memory, aside.noma-memory-index, aside.noma-metric, aside.noma-change-request, aside.noma-footnote, aside.noma-endnote, nav.noma-toc, header.noma-page-header, footer.noma-page-footer, details.noma-dataset, table.noma-table {\n    box-shadow: none;\n    page-break-inside: avoid;\n    break-inside: avoid;\n  }\n  .noma-computed, figure.noma-plot, figure.noma-plotly-wrap, figure.noma-diagram-wrap {\n    background: white;\n  }\n  table.noma-table {\n    font-size: 9.5pt;\n    box-shadow: none;\n  }\n  table.noma-table th,\n  table.noma-table td {\n    padding: 0.35em 0.55em;\n  }\n  h1, h2, h3 {\n    page-break-after: avoid;\n    break-after: avoid;\n  }\n  .noma-pagebreak {\n    margin: 0;\n    border: 0;\n    height: 0;\n    page-break-after: always;\n    break-after: page;\n  }\n}\n\n/* v0.4 \u2014 alias anchors (offset for sticky-headed pages) */\na.noma-alias {\n  display: block;\n  position: relative;\n  top: -1.2em;\n  visibility: hidden;\n  height: 0;\n}\n\n/* v0.4 \u2014 multi-page site nav (rendered above main when --to site) */\nnav.noma-site-nav {\n  max-width: 1040px;\n  margin: 1.5rem auto 0;\n  padding: 0 2rem;\n  display: flex;\n  align-items: baseline;\n  gap: 1.5rem;\n  flex-wrap: wrap;\n  font-size: 0.85rem;\n  color: var(--noma-muted);\n}\nnav.noma-site-nav a.noma-site-home {\n  font-weight: 600;\n  color: var(--noma-fg);\n  text-decoration: none;\n  border-right: 1px solid var(--noma-rule);\n  padding-right: 1.25rem;\n}\nnav.noma-site-nav ol {\n  list-style: none;\n  padding: 0;\n  margin: 0;\n  display: flex;\n  gap: 1.25rem;\n  flex-wrap: wrap;\n  counter-reset: chap;\n}\nnav.noma-site-nav li {\n  counter-increment: chap;\n}\nnav.noma-site-nav li::before {\n  content: counter(chap, decimal-leading-zero) " \xB7 ";\n  color: var(--noma-rule);\n  font-variant-numeric: tabular-nums;\n}\nnav.noma-site-nav a {\n  color: var(--noma-muted);\n  text-decoration: none;\n}\nnav.noma-site-nav a:hover { color: var(--noma-accent); }\nnav.noma-site-nav .noma-nav-current span {\n  color: var(--noma-fg);\n  font-weight: 500;\n}\n\na.noma-ref.noma-xchapter::after {\n  content: " \u2197";\n  font-size: 0.85em;\n  color: var(--noma-muted);\n}\n\nmain.noma-site-index {\n  padding-top: 3rem;\n}\nheader.noma-site-header h1 {\n  font-size: 2.4rem;\n  margin-bottom: 0.25rem;\n}\nheader.noma-site-header .noma-site-author {\n  color: var(--noma-muted);\n  margin: 0 0 2rem;\n}\nol.noma-site-toc {\n  list-style: none;\n  padding: 0;\n  margin: 2rem 0;\n  display: grid;\n  gap: 0.6rem;\n  counter-reset: toc;\n}\nol.noma-site-toc li {\n  counter-increment: toc;\n}\na.noma-site-chapter {\n  display: block;\n  padding: 1.1rem 1.4rem;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  text-decoration: none;\n  color: inherit;\n  transition: border-color 120ms ease, transform 120ms ease;\n}\na.noma-site-chapter:hover {\n  border-color: var(--noma-accent);\n  transform: translateY(-1px);\n}\na.noma-site-chapter::before {\n  content: counter(toc, decimal-leading-zero);\n  display: block;\n  font-size: 0.75rem;\n  font-variant-numeric: tabular-nums;\n  color: var(--noma-muted);\n  margin-bottom: 0.25rem;\n}\n.noma-site-chapter-title {\n  display: block;\n  font-weight: 600;\n  font-size: 1.1rem;\n}\n.noma-site-chapter-summary {\n  display: block;\n  color: var(--noma-muted);\n  margin-top: 0.4rem;\n  font-size: 0.93rem;\n}\n\n/* v0.4 \u2014 math (KaTeX is loaded from CDN; we just style block layout) */\n.noma-math-display {\n  margin: 1.4em auto;\n  text-align: center;\n  overflow-x: auto;\n}\n.noma-math-inline {\n  display: inline;\n}\n';

  // examples/agent-plan.noma
  var agent_plan_default = '---\ntitle: Agent Planning Artifact \u2014 Q3 Roadmap Decision\nauthor: ferax564\ndate: 2026-05-09\ntags: [planning, decision-record, agent-artifact]\n---\n\n# Q3 Roadmap Decision\n\n::summary\nThree candidate directions for next quarter. This document captures the\noptions, trade-offs, risks, and timeline as structured blocks so an agent\ncan revisit and update each section independently \u2014 and so the recommendation\ncan be exported as a prompt for a follow-on review pass.\n::\n\n## Options at a glance\n\n::grid{columns=3 min="14rem" gap="0.9rem" wide}\n:::card{title="A \xB7 Docs Platform" icon="docs"}\nBuild a hosted publishing target for Noma. Highest revenue ceiling, longest path to value.\n:::\n\n:::card{title="B \xB7 Research Workflows" icon="search"}\nLean into claims/evidence/risk blocks for analyst teams. Narrow ICP, fastest to first paying customer.\n:::\n\n:::card{title="C \xB7 General Reports" icon="report"}\nPosition Noma as the default format for AI-generated reports across domains. Broadest TAM, weakest wedge.\n:::\n::\n\n## Decision\n\n::decision{id="decision-q3-direction" status="proposed"}\nStart with **Option B \u2014 Research Workflows**. Narrowest wedge, fastest signal,\nkeeps the door open to A and C as adjacent expansions.\n::\n\n## Decision matrix\n\n| Dimension             | A \xB7 Docs | B \xB7 Research | C \xB7 Reports |\n| --------------------- | -------- | ------------ | ----------- |\n| Time to first revenue | 6\u20139 mo   | 6\u201310 wk      | 4\u20136 mo      |\n| Wedge sharpness       | Medium   | High         | Low         |\n| Existing block fit    | Strong   | Native       | Medium      |\n| Defensibility         | Network  | Workflow     | Brand only  |\n| 18-month revenue cap  | High     | Medium       | High        |\n\n## Claims and evidence\n\n::claim{id="claim-research-wedge" confidence=0.74}\nResearch and analyst teams are the sharpest wedge for Noma because their\nexisting tools (Word, Notion, Confluence) lack first-class claim/evidence/risk\nprimitives, and they already structure documents this way mentally.\n::\n\n::evidence{for="claim-research-wedge" source="user-interviews-apr-2026"}\nOf 11 analyst-team interviews in April, 9 described their current workflow as\n"copy-paste claims into a doc and hope someone catches stale ones." All 9 said\nthey would pay for a tool that flagged stale evidence automatically.\n::\n\n::claim{id="claim-docs-too-slow" confidence=0.68}\nA docs platform is the higher revenue ceiling, but time-to-revenue is too long\nto be the wedge. Better as a follow-on once Noma has format adoption.\n::\n\n::evidence{for="claim-docs-too-slow" source="docs-platform-benchmark-2026"}\nComparable docs-platform launches (Mintlify, GitBook) took 12\u201318 months to\nreach $100k ARR; research-tool launches (Mem, Reflect) hit it in 6\u20139 months\nwith a tighter ICP.\n::\n\n## Risks\n\n::risk{id="risk-narrow-icp" severity="medium" owner="ferax564"}\nResearch-team ICP is small (~3k orgs globally). Even high conversion caps the\nbusiness below docs-platform scale. Mitigation: use research wedge to drive\nformat adoption, then expand to docs.\n::\n\n::risk{id="risk-format-not-sticky" severity="high" owner="ferax564"}\nIf teams don\'t keep editing in Noma after first artifact, the workflow value\ndisappears. Mitigation: ship the agent patch protocol in week 3 so updates\nflow back into source automatically.\n::\n\n::risk{id="risk-llm-export-quality" severity="low" owner="ferax564"}\nLLM export quality determines whether agents trust Noma source as canonical.\nEasy to verify, easy to fix. Tracked separately.\n::\n\n## Timeline\n\n::grid{columns=4 min="12rem" compact wide}\n:::card{title="Wk 1 \xB7 Format"}\nParser, AST, frontmatter, JSON export, basic validation.\n:::\n\n:::card{title="Wk 2 \xB7 Artifact"}\nHTML renderer, default theme, cards/grids/tabs/charts, mobile.\n:::\n\n:::card{title="Wk 3 \xB7 Agent"}\nLLM export, patch protocol, copy-as-prompt buttons.\n:::\n\n:::card{title="Wk 4 \xB7 Launch"}\n3 demos, README, spec, comparison page, OSS release.\n:::\n::\n\n## Open questions\n\n::open_question{id="oq-pricing-model"}\nPer-seat, per-document, or per-render? Research-team workflows favor per-seat;\nagent-driven artifacts favor per-render. Decide before week 3.\n::\n\n::open_question{id="oq-pdf-engine"}\nKeep Puppeteer as the report-PDF path or add Typst for longer books? Puppeteer\nnow covers first-class PDFs; Typst may still be worth evaluating for book output.\n::\n\n## Agent tasks\n\n::agent_task{id="task-validate-claim-research-wedge"}\nRe-run the interview tally each month. If `claim-research-wedge` evidence base\ndrops below 8 of 11 supporting interviews (or new interviews contradict),\nlower the claim\'s `confidence` attribute and add a `counterevidence` block.\n::\n\n::agent_task{id="task-watch-stale-evidence"}\nEvery two weeks, scan `evidence` blocks for `source` attributes older than\n60 days. Flag any whose underlying source has changed materially. Do not\nauto-edit \u2014 propose a `replace_block` patch for human approval.\n::\n\n::agent_task{id="task-export-as-review-prompt"}\nOn request, package this document\'s `decision`, top three `claim`s, and all\n`risk`s of severity \u2265 medium into an LLM prompt for a second-opinion review.\n::\n\n## Export\n\n::export_button{format="prompt" target="decision-q3-direction"}\nLabel: Copy decision + risks as a review prompt\n::\n\n::export_button{format="markdown" target="summary"}\nLabel: Copy summary as Markdown\n::\n\n::export_button{format="json" target="document"}\nLabel: Copy full document AST\n::\n\n> The point of this artifact is not the prose \u2014 it\'s that an agent can re-open\n> it next month, walk the decision/claim/risk graph, and update only the parts\n> that changed. Everything else stays put, and the Git diff stays clean.\n';

  // examples/tech-doc.noma
  var tech_doc_default = '---\ntitle: Noma CLI Reference\nauthor: ferax564\ndate: 2026-05-09\ntags: [docs, reference, cli]\n---\n\n# Noma CLI Reference\n\n::summary\nThe `noma` CLI parses, renders, and validates `.noma` source files. This page\nis itself written in Noma \u2014 the same source produces the rendered HTML you\'re\nreading and the deterministic LLM context an agent would consume.\n::\n\n## Install\n\n```bash\nnpm install -g @ferax564/noma-cli\n# or one-off\nnpx @ferax564/noma-cli render path/to/file.noma --to html\n```\n\n::callout{tone="tip"}\nThe CLI auto-detects the `themes/default.css` shipped with the package. To\nuse a custom theme, pass `--theme path/to/theme.css` (coming in v0.2).\n::\n\n## Commands\n\n::tabs\n:::tab{title="parse"}\n### `noma parse <file>`\n\nPrint the parsed AST as JSON. Useful for debugging the parser or building\ntools that consume Noma documents.\n\n```bash\nnoma parse examples/thesis.noma\nnoma parse examples/thesis.noma --out ast.json\n```\n\nReturns the full typed AST defined in `src/ast.ts`. Block IDs are stable\nacross re-parses of unchanged content, so AST diffs map cleanly to source\ndiffs.\n:::\n\n:::tab{title="render"}\n### `noma render <file> [--to <target>]`\n\nRender a `.noma` file to one of the supported targets.\n\n| Target | Output                                               |\n| ------ | ---------------------------------------------------- |\n| `html` | Standalone HTML document with the default theme      |\n| `pdf`  | Report PDF printed from the HTML renderer            |\n| `llm`  | Deterministic plain-text context for LLM consumption |\n| `json` | The parsed AST (alias of `noma export`)              |\n\n```bash\nnoma render docs/spec.noma --to html --out dist/spec.html\nnoma render docs/spec.noma --to pdf --out dist/spec.pdf\nnoma render docs/spec.noma --to llm\nnoma render docs/spec.noma --to json --out dist/spec.json\n```\n\nUse `--no-standalone` to emit just the HTML body (for embedding inside an\nexisting page). Use `--title "..."` to override the document title. PDF output\nrequires `--out` and accepts `--page-size`, `--margin`, `--no-print-background`,\nand `--css`.\n:::\n\n:::tab{title="check"}\n### `noma check <file>`\n\nValidate a Noma document. Exits 1 if any errors are present, 0 otherwise.\n\n```bash\nnoma check examples/thesis.noma\n```\n\nCatches: duplicate block IDs, broken `for=` references on evidence blocks,\nbroken internal links, invalid frontmatter, plot blocks missing a dataset\nor `data=` attribute, and (in v0.2) claims missing supporting evidence.\n:::\n\n:::tab{title="export"}\n### `noma export <file>`\n\nAlias for `noma render <file> --to json`. Kept as a separate command because\nit\'s the most common scripted use case (CI pipelines, agent context, RAG\nindexing).\n:::\n::\n\n## Architecture\n\n::grid{columns=3}\n:::card{title="Parser" icon="parse"}\nHand-written recursive descent. Tracks fence depth by counting leading colons.\nNever throws on malformed input \u2014 produces a best-effort AST and lets the\nvalidator complain.\n:::\n\n:::card{title="AST" icon="tree"}\nDiscriminated union in `src/ast.ts`. Single source of truth. Adding a node\ntype is a one-line change that the TypeScript compiler propagates to every\nrenderer\'s switch.\n:::\n\n:::card{title="Renderers" icon="render"}\nPure functions. `AST \u2192 string`. No I/O, no globals. Three in core today\n(HTML, LLM, JSON); PDF is a wrapper around the HTML renderer + Puppeteer.\n:::\n::\n\n## Data flow\n\n```txt\n.noma source\n   \u2502\n   \u25BC\n\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\n\u2502  Parser  \u2502  src/parser.ts  (line-based, recursive descent)\n\u2514\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2518\n      \u2502  typed AST  (src/ast.ts)\n      \u25BC\n\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\n\u2502  Renderers (pure)                \u2502\n\u2502  \u251C\u2500\u2500 renderer-html.ts \u2192 HTML     \u2502\n\u2502  \u251C\u2500\u2500 renderer-llm.ts  \u2192 LLM ctx  \u2502\n\u2502  \u2514\u2500\u2500 renderer-json.ts \u2192 JSON     \u2502\n\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\n           \u2502\n           \u25BC\n       artifact\n```\n\n## Common errors\n\n::callout{tone="warning"}\n**Stray triple-colon at top level.** `:::card` only opens a child block one\nlevel deeper. At the top of a document it has no parent and the parser will\nemit a `parser/orphan-fence` diagnostic. Fix: wrap in `::grid` or use `::card`.\n::\n\n::callout{tone="warning"}\n**Duplicate block ID.** Block IDs are user-facing API. The validator emits\n`validator/duplicate-id` and `noma check` exits non-zero. Fix: rename one\nof the blocks. If they were intentionally duplicated, they shouldn\'t have\nbeen \u2014 split or merge.\n::\n\n::callout{tone="note"}\n**Plot without data.** A `::plot` block without a `data=` or `dataset=`\nattribute renders as a placeholder SVG. The validator emits\n`validator/plot-missing-data` as a warning, not an error, so the build\nstill passes \u2014 but the artifact won\'t have real data in it.\n::\n\n## Programmatic use\n\n```ts\nimport { parse, renderHtml, validate } from "@ferax564/noma-cli";\n\nconst source = await fs.readFile("doc.noma", "utf8");\nconst ast = parse(source, { filename: "doc.noma" });\nconst diagnostics = validate(ast);\nif (diagnostics.some(d => d.severity === "error")) {\n  throw new Error("invalid Noma document");\n}\nconst html = renderHtml(ast, { standalone: true });\n```\n\n## Patch protocol (preview, v0.3)\n\nAgents should not rewrite full files. They propose block-level operations\nthat the CLI applies safely.\n\n```json\n{\n  "op": "replace_block",\n  "id": "asml-euv-moat",\n  "content": "ASML\'s moat rests on EUV optics, mechanics, and supply chain \u2014 not just exclusivity."\n}\n```\n\nOperations: `add_block`, `replace_block`, `delete_block`, `move_block`,\n`update_attribute`, `add_evidence`, `add_comment`, `resolve_comment`,\n`rename_id`. See `docs/agent-protocol.noma` for the full schema.\n\n## Architecture (v0.5 \u2014 interactive diagrams)\n\n::diagram{kind="mermaid" id="cli-flow"}\nflowchart LR\n  A[.noma source] --> B[parser]\n  B --> C[AST]\n  C --> D[validator]\n  C --> E[renderer-html]\n  C --> F[renderer-llm]\n  C --> G[renderer-noma]\n  G --> H[noma fmt / patch]\n::\n\n## Cross-links\n\n- See `docs/spec.noma` for the full block reference.\n- See `docs/agent-protocol.noma` for the patch protocol.\n- See `docs/direction.noma` for the product positioning.\n- See `examples/research-thesis.noma` for a reasoning-heavy demo.\n';

  // examples/research-thesis.noma
  var research_thesis_default = '---\ntitle: Vertical AI Agents \u2014 Investment Thesis\nauthor: ferax564\ndate: 2026-05-09\ntags: [ai, vertical-saas, thesis, research]\n---\n\n# Vertical AI Agents \u2014 Investment Thesis\n\n::summary\nHorizontal LLM platforms commoditize fast. The durable value sits in\n**vertical agents** that own a workflow end-to-end inside a single\ndomain \u2014 legal review, claims processing, financial-statement audit,\nclinical documentation. This thesis lays out the structural reasons,\nthe supporting evidence, the leading indicators to watch, and the\ndisqualifying conditions that would invalidate it.\n::\n\n## Thesis at a glance\n\n::grid{columns=2}\n:::card{title="Bull Case" icon="up"}\nDomain-specific agents win on data depth, workflow integration, and\nliability ownership. Each vertical can support 1\u20133 category leaders\nwith $500M+ ARR within 5 years.\n:::\n\n:::card{title="Bear Case" icon="down"}\nFrontier model gains compress the gap. A horizontal model with strong\ntool use plus a thin vertical wrapper captures most of the value.\nVertical agents become features, not companies.\n:::\n::\n\n## Core claims\n\n::claim{id="claim-data-moat" confidence=0.78}\nVertical agents accumulate proprietary workflow data \u2014 corrections,\nedge-case patterns, customer-specific schemas \u2014 that horizontal agents\ncannot replicate by scaling base-model capability alone.\n::\n\n::evidence{for="claim-data-moat" source="harvey-public-disclosures-2026q1"}\nHarvey reports that 71% of model improvements in the last 12 months\ncame from fine-tuning on proprietary corrections collected in customer\ndeployments \u2014 not from base-model upgrades.\n::\n\n::evidence{for="claim-data-moat" source="ambience-customer-case-2026"}\nAmbience Healthcare\'s clinical-documentation agent improved acceptance\nrates from 62% to 89% after twelve months in production at a single\nhospital network \u2014 the gain was specific to that network\'s documentation\nconventions and did not transfer to the open-source baseline.\n::\n\n::claim{id="claim-liability-moat" confidence=0.71}\nIn regulated verticals, the agent vendor must own legal liability for\nagent output. This forces a stack of guarantees (audit logs, escalation,\nhuman-in-loop sign-off, SOC 2/HIPAA) that takes years to build and is\nadversarial to horizontal generalists.\n::\n\n::evidence{for="claim-liability-moat" source="legal-tech-procurement-survey-2026"}\n89% of in-house legal teams surveyed in Q1 2026 said "vendor accepts\nindemnification for agent output" was a hard requirement for production\ndeployment. Only 4 vendors met the bar; all 4 are vertical specialists.\n::\n\n::claim{id="claim-workflow-stickiness" confidence=0.74}\nThe integration surface \u2014 clearinghouses, EHRs, court filing systems,\npractice-management software \u2014 is a structural moat, not a feature gap.\nEach integration is custom, slow, and high-trust.\n::\n\n::counterevidence{for="claim-workflow-stickiness" source="model-context-protocol-traction-2026"}\nThe Model Context Protocol (MCP) is reducing per-integration cost by an\norder of magnitude in some verticals. If MCP-style adapters become\nuniversal, the integration moat compresses faster than the data moat does.\n::\n\n## Risks\n\n::risk{id="risk-frontier-leap" severity="high" owner="ferax564"}\nA frontier-model capability leap (e.g., GPT-6-class reasoning + native\nlong-horizon tool use) could collapse the workflow gap. Most vulnerable\nverticals: those where workflow complexity comes from reasoning chains\nrather than data integration (e.g., research synthesis).\n::\n\n::risk{id="risk-platform-shift" severity="medium" owner="ferax564"}\nIf the major model providers ship vertical-agent SDKs with\nrevenue-share models, distribution shifts toward platform-bundled\nofferings. Mitigation: invest in customer ownership of data\n(BYO-storage, on-prem options).\n::\n\n::risk{id="risk-regulatory-freeze" severity="medium" owner="ferax564"}\nEU AI Act high-risk classification or US sector-specific rules (FDA,\nSEC) could freeze deployments for 12\u201318 months in the affected\nverticals. This *helps* incumbents and *helps* well-capitalized\nvendors with compliance teams \u2014 and disproportionately hurts startups.\n::\n\n::risk{id="risk-talent-concentration" severity="low" owner="ferax564"}\nTop vertical talent is concentrated in 4\u20136 startups per category.\nAcquihire risk is real but bounded; not a thesis-breaker.\n::\n\n## What would invalidate the thesis\n\n::open_question{id="invalidator-frontier-tool-use"}\nA frontier model that achieves >85% acceptance on a high-stakes\nvertical workflow (clinical docs, deposition review, SEC filing prep)\nwithout any vertical-specific tuning. If this happens within 18 months,\nthe data moat is weaker than claimed and `confidence` on\n`claim-data-moat` should drop below 0.5.\n::\n\n::open_question{id="invalidator-mcp-universal"}\nUniversal MCP-style adapters that reduce vertical integration cost from\nweeks to hours across at least three regulated verticals. If this ships\nbroadly within 12 months, `claim-workflow-stickiness` confidence should\ndrop below 0.5.\n::\n\n## Quantitative backdrop\n\n::dataset{id="vertical-ai-funding"}\nschema:\n  vertical: string\n  funded_companies: number\n  total_funding_usd_m: number\n  median_arr_growth_yoy: number\nrows:\n  - [legal, 14, 1280, 3.4]\n  - [healthcare, 22, 2650, 2.9]\n  - [financial-audit, 9, 540, 4.1]\n  - [insurance, 11, 720, 3.6]\n  - [construction, 6, 290, 2.7]\n::\n\n::plot{id="vertical-ai-arr-plot" type="bar" dataset="vertical-ai-funding" column="median_arr_growth_yoy" xcolumn="vertical" title="Median ARR YoY growth by vertical (2026)"}\n::\n\n::plot{id="vertical-ai-funding-plot" type="line" dataset="vertical-ai-funding" column="total_funding_usd_m" xcolumn="vertical" title="Total funding raised by vertical ($M)"}\n::\n\n## Watchlist (positions, not recommendations)\n\n| Vertical         | Public proxy          | Private leader       | Note                                  |\n| ---------------- | --------------------- | -------------------- | ------------------------------------- |\n| Legal            | RELX, Thomson Reuters | Harvey, EvenUp       | Watch incumbents\' agent rollouts      |\n| Clinical docs    | \u2014                     | Abridge, Ambience    | Acceptance rate is the leading metric |\n| Financial audit  | Intuit, S&P           | Numeric, Trullion    | Audit-trail UX is the moat            |\n| Insurance claims | Verisk                | Sixfold, EvolutionIQ | Loss-ratio impact is the proof point  |\n\n## Deltas since last update\n\n::state_change{block="claim-data-moat" attribute="confidence" from=0.72 to=0.78 reason="Harvey\'s Q1 disclosure quantified the proprietary-correction loop more concretely than expected" at="2026-05-09"}\n::\n\n::state_change{block="claim-liability-moat" attribute="confidence" from=0.65 to=0.71 reason="legal-tech procurement survey put the indemnification requirement at 89%, vs. 71% the prior survey" at="2026-05-09"}\n::\n\n## Quarterly review task\n\n::agent_task{id="quarterly-thesis-review"}\nEvery quarter (Q1: Mar 31, Q2: Jun 30, Q3: Sep 30, Q4: Dec 31), walk this\ndocument and:\n\n1. For each `claim`, check whether new public evidence supports or\n   contradicts. If material, add a fresh `evidence` or `counterevidence`\n   block and adjust the `confidence` attribute.\n2. For each `risk`, check whether the leading indicators have moved.\n   Adjust `severity` if warranted.\n3. For each `open_question` invalidator, check whether the trigger\n   condition has been met. If yes, escalate to a `decision` block\n   recommending exit or rebalance.\n4. Do not delete prior evidence. Append, don\'t overwrite \u2014 the audit\n   trail is the value.\n::\n\n## Stale-evidence guard\n\n::agent_task{id="stale-evidence-scan"}\nEvery two weeks, scan all `evidence` blocks for `source` attributes\nolder than 90 days. Propose (do not apply) a `replace_block` patch for\neach, citing the latest available source.\n::\n\n## Export\n\n::export_button{format="prompt" target="document"}\nLabel: Copy as second-opinion review prompt\n::\n\n::export_button{format="llm" target="document"}\nLabel: Copy structured LLM context\n::\n\n::export_button{format="markdown" target="summary"}\nLabel: Copy summary as Markdown\n::\n\n> A thesis is only useful if you can revisit it. The blocks above are\n> structured so a future-you (or a future agent acting on your behalf)\n> can update only what changed, leave the rest alone, and produce a\n> clean Git diff that shows exactly which beliefs moved.\n';

  // examples/interactive-projection.noma
  var interactive_projection_default = '---\ntitle: Interactive Projection Demo\nauthor: ferax564\ndate: 2026-06-04\n---\n\n# Interactive Projection Demo\n\nThis artifact models a simple account expansion plan. The controls update\ncomputed metrics, a chart, and a table in the browser; the current control\nstate is stored in the URL hash so the scenario can be shared.\n\n::grid{columns=3 min="13rem" gap="0.8rem" wide compact}\n:::control{id="accounts" type="number" min=50 max=1000 step=25 default=250 label="Starting accounts" unit="accounts"}\n:::\n\n:::control{id="growth_rate" type="slider" min=0 max=45 step=1 default=18 label="Annual growth" unit="%"}\n:::\n\n:::control{id="retention" type="slider" min=70 max=100 step=1 default=92 label="Retention" unit="%"}\n:::\n::\n\n::grid{columns=3 min="14rem" gap="0.8rem" wide compact}\n:::computed_metric{id="year_3_accounts" label="Year 3 accounts" formula="round(accounts * pow(1 + growth_rate / 100, 3) * pow(retention / 100, 3), 0)" unit="accounts"}\nThe static value comes from defaults; browser controls recompute it instantly.\n:::\n\n:::computed_metric{id="year_5_accounts" label="Year 5 accounts" formula="round(accounts * pow(1 + growth_rate / 100, 5) * pow(retention / 100, 5), 0)" unit="accounts"}\nThis block can be referenced by downstream computed blocks or exported to LLM context.\n:::\n\n:::computed_metric{id="net_growth" label="Net annual growth" formula="round(((1 + growth_rate / 100) * (retention / 100) - 1) * 100, 1)" unit="%"}\nThe formula language supports arithmetic, comparisons, and simple functions.\n:::\n::\n\n::computed_plot{id="accounts_curve" label="Account curve" formula="round(accounts * pow(1 + growth_rate / 100, year) * pow(retention / 100, year), 0)" domain="year:0..5" type="bar" width=720 height=220 x_label_wrap=6}\n::\n\n::computed_table{id="accounts_table" label="Scenario table" formula="round(accounts * pow(1 + growth_rate / 100, year) * pow(retention / 100, year), 0)" domain="year:0..5" unit="accounts" variable_label="Year" value_label="Projected accounts"}\nShare a scenario by copying the URL after moving the controls.\n::\n\n::export_button{format="llm" target="document"}\nLabel: Copy LLM context\n::\n\n::export_button{format="json" target="document"}\nLabel: Copy JSON AST\n::\n';

  // examples/word-review-loop.noma
  var word_review_loop_default = '---\ntitle: Word Review Loop Demo\nauthor: ferax564\ndate: 2026-06-04\n---\n\n# Word Review Loop Demo\n\nThis document is source-controlled Noma that can be handed to a reviewer as a\nWord package. The review controls, comments, and change requests stay tied to\nstable block IDs so an agent can reconcile the returned document without a\nfull-file rewrite.\n\n::page_setup{size="letter" margins="0.7in 0.85in 0.75in 0.85in"}\n::\n\n::header\nWord review loop - confidential draft\n::\n\n::footer\nNoma source -> DOCX handoff -> extracted review data\n::\n\n## Review Controls\n\n::grid{columns=3 min="13rem" gap="0.8rem" wide compact}\n:::control{id="review_decision" type="select" default="revise" options="approve=Approve,revise=Revise,block=Block" label="Reviewer decision"}\n:::\n\n:::control{id="legal_ready" type="toggle" default=false label="Ready for legal"}\n:::\n\n:::control{id="confidence_score" type="slider" min=0 max=100 step=5 default=70 label="Reviewer confidence" unit="%"}\n:::\n::\n\n::computed_table{id="review_scorecard" label="Confidence scenarios" formula="round(confidence_score * stage / 3, 0)" domain="stage:1..3" unit="%" variable_label="Review stage" value_label="Effective confidence"}\nThe table exports as native HTML and DOCX table rows while remaining computed\nfrom the editable controls.\n::\n\n## Renewal Terms\n\n::decision{id="renewal-terms-decision" owner="Commercial" status="draft"}\nAdopt a two-year renewal with a 60-day opt-out window and pricing protection\nfor seats already committed in the current order form.\n::\n\n::comment{id="comment-legal-window" for="renewal-terms-decision" author="Legal" date="2026-06-04"}\nConfirm whether the opt-out clock starts at signature or production launch.\n::\n\n::change_request{id="cr-renewal-terms" for="renewal-terms-decision" status="open" priority="high"}\nReplace "60-day opt-out window" with the final legal trigger once counsel\nconfirms the timing.\n::\n\n::table{id="handoff-matrix" title="Review handoff matrix" header align="l,l,l"}\nArea | Owner | Return signal\nCommercial terms | Commercial | `review_decision`\nLegal readiness | Legal | `legal_ready`\nRisk confidence | Strategy | `confidence_score`\n::\n\n## Agent Reconciliation\n\n::agent_task{id="extract-word-review" assignee="agent" status="todo"}\nRun `noma docx-data dist/examples/word-review-loop.docx`, inspect reviewer\ncontrol values, and apply source updates only to blocks referenced by changed\ncontrols or review annotations.\n::\n\n::export_button{format="llm" target="document"}\nLabel: Copy agent handoff context\n::\n';

  // web/workbench.ts
  var examples = [
    { id: "agent-plan", label: "Agent plan", source: agent_plan_default },
    { id: "tech-doc", label: "Tech doc", source: tech_doc_default },
    { id: "research-thesis", label: "Research thesis", source: research_thesis_default },
    { id: "interactive-projection", label: "Interactive projection", source: interactive_projection_default },
    { id: "word-review-loop", label: "Word review loop", source: word_review_loop_default }
  ];
  var storageKey = "noma.workbench.source.v1";
  var ribbonStorageKey = "noma.workbench.ribbon.v1";
  var ribbonTabs = /* @__PURE__ */ new Set(["file", "format", "insert", "layout", "review", "find", "export"]);
  var initialSource = localStorage.getItem(storageKey) ?? examples[0].source;
  var sourceInput = requireElement("sourceInput");
  var previewFrame = requireElement("previewFrame");
  var outputPre = requireElement("outputPre");
  var diagnosticsList = requireElement("diagnosticsList");
  var outlineList = requireElement("outlineList");
  var statusText = requireElement("statusText");
  var exampleSelect = requireElement("exampleSelect");
  var loadExampleButton = requireElement("loadExample");
  var newDocumentButton = requireElement("newDocument");
  var fileInput = requireElement("fileInput");
  var downloadSourceButton = requireElement("downloadSource");
  var downloadHtmlButton = requireElement("downloadHtml");
  var downloadJsonButton = requireElement("downloadJson");
  var copyLlmButton = requireElement("copyLlm");
  var copyDocxCommandButton = requireElement("copyDocxCommand");
  var printPreviewButton = requireElement("printPreview");
  var previewEditToggle = requireElement("previewEditToggle");
  var renderButton = requireElement("renderNow");
  var findInput = requireElement("findInput");
  var findPrevButton = requireElement("findPrev");
  var findNextButton = requireElement("findNext");
  var findStatus = requireElement("findStatus");
  var targetButtons = [...document.querySelectorAll("[data-target]")];
  var commandButtons = [...document.querySelectorAll("[data-command]")];
  var ribbonTabButtons = [...document.querySelectorAll("[data-ribbon-tab]")];
  var ribbonPanels = [...document.querySelectorAll("[data-ribbon-panel]")];
  var outputMode = "preview";
  var activeRibbonTab = initialRibbonTab();
  var previewEditMode = false;
  var renderTimer;
  var state = emptyState();
  sourceInput.value = initialSource;
  populateExamples();
  renderRibbonTabs();
  bindEvents();
  renderCurrent();
  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id}`);
    return element;
  }
  function populateExamples() {
    for (const example of examples) {
      const option = document.createElement("option");
      option.value = example.id;
      option.textContent = example.label;
      exampleSelect.append(option);
    }
  }
  function bindEvents() {
    sourceInput.addEventListener("input", () => {
      localStorage.setItem(storageKey, sourceInput.value);
      scheduleRender();
    });
    renderButton.addEventListener("click", () => renderCurrent());
    newDocumentButton.addEventListener("click", () => {
      setSource(starterDocument(), "Untitled Document");
    });
    loadExampleButton.addEventListener("click", () => {
      const example = examples.find((item) => item.id === exampleSelect.value) ?? examples[0];
      setSource(example.source, example.label);
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      setSource(await file.text(), file.name);
      fileInput.value = "";
    });
    for (const button of targetButtons) {
      button.addEventListener("click", () => {
        const next = button.dataset.target;
        if (next === "preview" || next === "json" || next === "llm") {
          outputMode = next;
          renderOutput();
        }
      });
    }
    for (const button of ribbonTabButtons) {
      button.addEventListener("click", () => {
        const tab = button.dataset.ribbonTab;
        if (isRibbonTab(tab)) setRibbonTab(tab);
      });
      button.addEventListener("keydown", (event) => handleRibbonTabKeydown(event, button));
    }
    downloadSourceButton.addEventListener("click", () => {
      downloadText("document.noma", sourceInput.value, "text/plain");
    });
    downloadHtmlButton.addEventListener("click", () => {
      if (state.error) return;
      downloadText("document.html", state.html, "text/html");
    });
    downloadJsonButton.addEventListener("click", () => {
      if (state.error) return;
      downloadText("document.json", state.json, "application/json");
    });
    copyLlmButton.addEventListener("click", async () => {
      if (state.error) return;
      await copyText(state.llm, "Copied LLM context");
    });
    copyDocxCommandButton.addEventListener("click", async () => {
      await copyText("npm run noma -- render document.noma --to docx --out document.docx", "Copied DOCX command");
    });
    printPreviewButton.addEventListener("click", () => {
      printPreview();
    });
    previewEditToggle.addEventListener("click", () => {
      previewEditMode = !previewEditMode;
      if (previewEditMode && outputMode !== "preview") outputMode = "preview";
      renderOutput();
      showTransientStatus(previewEditMode ? "Rendered editing on" : "Rendered editing off");
    });
    previewFrame.addEventListener("load", () => installPreviewEditing());
    for (const button of commandButtons) {
      button.addEventListener("click", () => {
        const command = button.dataset.command;
        if (isCommandName(command)) runCommand(command);
      });
    }
    findInput.addEventListener("input", () => updateFindStatus());
    findNextButton.addEventListener("click", () => findInSource(1));
    findPrevButton.addEventListener("click", () => findInSource(-1));
    sourceInput.addEventListener("keydown", (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        runCommand("bold");
      } else if (key === "i") {
        event.preventDefault();
        runCommand("italic");
      } else if (key === "k") {
        event.preventDefault();
        runCommand("link");
      } else if (key === "s") {
        event.preventDefault();
        downloadText("document.noma", sourceInput.value, "text/plain");
      } else if (key === "p") {
        event.preventDefault();
        printPreview();
      } else if (key === "f") {
        event.preventDefault();
        setRibbonTab("find");
        window.requestAnimationFrame(() => {
          findInput.focus();
          findInput.select();
        });
      }
    });
  }
  function scheduleRender() {
    if (renderTimer !== void 0) window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      renderTimer = void 0;
      renderCurrent();
    }, 220);
  }
  function isCommandName(value) {
    return typeof value === "string" && commandNames.has(value);
  }
  function initialRibbonTab() {
    const storedTab = localStorage.getItem(ribbonStorageKey);
    return isRibbonTab(storedTab) ? storedTab : "file";
  }
  function isRibbonTab(value) {
    return typeof value === "string" && ribbonTabs.has(value);
  }
  function setRibbonTab(tab) {
    activeRibbonTab = tab;
    localStorage.setItem(ribbonStorageKey, tab);
    renderRibbonTabs();
  }
  function renderRibbonTabs() {
    for (const button of ribbonTabButtons) {
      const selected = button.dataset.ribbonTab === activeRibbonTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of ribbonPanels) {
      panel.hidden = panel.dataset.ribbonPanel !== activeRibbonTab;
    }
  }
  function handleRibbonTabKeydown(event, button) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const currentIndex = ribbonTabButtons.indexOf(button);
    if (currentIndex === -1) return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + offset + ribbonTabButtons.length) % ribbonTabButtons.length;
    const nextButton = ribbonTabButtons[nextIndex];
    const nextTab = nextButton?.dataset.ribbonTab;
    if (!nextButton || !isRibbonTab(nextTab)) return;
    setRibbonTab(nextTab);
    nextButton.focus();
  }
  var commandNames = /* @__PURE__ */ new Set([
    "bold",
    "italic",
    "code",
    "link",
    "heading1",
    "heading2",
    "heading3",
    "bullets",
    "numbers",
    "quote",
    "codeblock",
    "insertTable",
    "insertFigure",
    "insertCallout",
    "insertTask",
    "insertControl",
    "insertMath",
    "insertToc",
    "insertHeader",
    "insertFooter",
    "insertPageSetup",
    "insertPageBreak",
    "insertComment",
    "insertChange",
    "insertFootnote"
  ]);
  function runCommand(command) {
    switch (command) {
      case "bold":
        wrapSelection("**", "**", "bold text");
        break;
      case "italic":
        wrapSelection("*", "*", "emphasis");
        break;
      case "code":
        wrapSelection("`", "`", "code");
        break;
      case "link":
        insertLink();
        break;
      case "heading1":
        setHeading(1);
        break;
      case "heading2":
        setHeading(2);
        break;
      case "heading3":
        setHeading(3);
        break;
      case "bullets":
        prefixSelectedLines((line) => `- ${stripListMarker(line)}`);
        break;
      case "numbers":
        prefixSelectedLines((line, index) => `${index + 1}. ${stripListMarker(line)}`);
        break;
      case "quote":
        prefixSelectedLines((line) => `> ${line.replace(/^>\s?/, "")}`);
        break;
      case "codeblock":
        wrapBlock("```\n", "\n```", "code");
        break;
      case "insertTable":
        insertTemplate("| Column | Status |\n|---|---|\n| Item | Draft |", "Item");
        break;
      case "insertFigure":
        insertTemplate(`::figure{id="${nextId("figure")}" alt="Describe image" caption="{{cursor}}Figure caption"}
Add image description or source details.
::`, "Figure caption");
        break;
      case "insertCallout":
        insertTemplate(`::callout{id="${nextId("callout")}" title="Note"}
{{cursor}}Add note text.
::`, "Add note text.");
        break;
      case "insertTask":
        insertTemplate(`::todo{id="${nextId("todo")}" status="open" owner="" due=""}
{{cursor}}Task description.
::`, "Task description.");
        break;
      case "insertControl":
        insertTemplate(`::control{id="${nextId("control")}" type="text" label="Field" default="{{cursor}}Value"}
::`, "Value");
        break;
      case "insertMath":
        insertTemplate(`::math{id="${nextId("math")}"}
{{cursor}}E = mc^2
::`, "E = mc^2");
        break;
      case "insertToc":
        insertTemplate(`::toc{id="${nextId("toc")}" depth=3}
::`);
        break;
      case "insertHeader":
        insertTemplate(`::header{id="${nextId("header")}"}
{{cursor}}Document header
::`, "Document header");
        break;
      case "insertFooter":
        insertTemplate(`::footer{id="${nextId("footer")}" page_numbers total_pages}
{{cursor}}Document footer
::`, "Document footer");
        break;
      case "insertPageSetup":
        insertTemplate('::page_setup{size="A4" margin="18mm"}\n::');
        break;
      case "insertPageBreak":
        insertTemplate(`::pagebreak{id="${nextId("pagebreak")}"}
::`);
        break;
      case "insertComment":
        insertTemplate(`::comment{id="${nextId("comment")}" parent="" author=""}
{{cursor}}Review note.
::`, "Review note.");
        break;
      case "insertChange":
        insertTemplate(`::change_request{id="${nextId("change")}" action="replace" from="{{cursor}}old text" to="new text"}
::`, "old text");
        break;
      case "insertFootnote":
        insertTemplate(`::footnote{id="${nextId("footnote")}"}
{{cursor}}Footnote text.
::`, "Footnote text.");
        break;
    }
  }
  function setSource(source, label) {
    sourceInput.value = source;
    localStorage.setItem(storageKey, sourceInput.value);
    sourceInput.focus();
    sourceInput.setSelectionRange(0, 0);
    renderCurrent();
    if (label) showTransientStatus(`Loaded ${label}`);
  }
  function starterDocument() {
    return `---
title: Untitled Noma Document
profile: technical
---

# Untitled Document

Start writing here.
`;
  }
  function wrapSelection(prefix, suffix, placeholder) {
    const selection = sourceSelection();
    const body = selection.text || placeholder;
    const inserted = `${prefix}${body}${suffix}`;
    replaceRange(selection.start, selection.end, inserted, selection.start + prefix.length, selection.start + prefix.length + body.length);
  }
  function wrapBlock(prefix, suffix, placeholder) {
    const selection = sourceSelection();
    const body = selection.text || placeholder;
    const inserted = `${prefix}${body}${suffix}`;
    replaceRange(selection.start, selection.end, inserted, selection.start + prefix.length, selection.start + prefix.length + body.length);
  }
  function insertLink() {
    const selection = sourceSelection();
    const label = selection.text || "link text";
    const inserted = `[${label}](https://example.com)`;
    replaceRange(selection.start, selection.end, inserted, selection.start + 1, selection.start + 1 + label.length);
  }
  function setHeading(level) {
    const source = sourceInput.value;
    const bounds = currentLineBounds();
    const line = source.slice(bounds.start, bounds.end);
    const clean = line.replace(/^#{1,6}\s+/, "").trim() || "Heading";
    const next = `${"#".repeat(level)} ${clean}`;
    replaceRange(bounds.start, bounds.end, next, bounds.start + level + 1, bounds.start + next.length);
  }
  function prefixSelectedLines(transform) {
    const source = sourceInput.value;
    const selection = sourceSelection();
    const start = source.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
    const nextBreak = source.indexOf("\n", selection.end);
    const end = nextBreak === -1 ? source.length : nextBreak;
    const lines = source.slice(start, end).split("\n");
    const transformed = lines.map((line, index) => transform(line, index)).join("\n");
    replaceRange(start, end, transformed, start, start + transformed.length);
  }
  function stripListMarker(line) {
    return line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
  }
  function insertTemplate(rawTemplate, selectionHint) {
    const selection = sourceSelection();
    const marker = "{{cursor}}";
    const markerIndex = rawTemplate.indexOf(marker);
    const template = rawTemplate.replace(marker, "");
    const before = sourceInput.value.slice(0, selection.start);
    const after = sourceInput.value.slice(selection.end);
    const prefix = before.length > 0 && !before.endsWith("\n\n") ? "\n\n" : "";
    const suffix = after.length > 0 && !after.startsWith("\n\n") ? "\n\n" : "";
    const inserted = `${prefix}${template}${suffix}`;
    const cursorStart = selection.start + prefix.length + (markerIndex >= 0 ? markerIndex : template.length);
    const cursorEnd = selectionHint ? cursorStart + selectionHint.length : cursorStart;
    replaceRange(selection.start, selection.end, inserted, cursorStart, cursorEnd);
  }
  function nextId(prefix) {
    const source = sourceInput.value;
    for (let i = 1; i < 1e3; i++) {
      const candidate = `${prefix}-${i}`;
      if (!source.includes(`id="${candidate}"`) && !source.includes(`id=${candidate}`)) return candidate;
    }
    return `${prefix}-${Date.now()}`;
  }
  function sourceSelection() {
    const start = sourceInput.selectionStart;
    const end = sourceInput.selectionEnd;
    return { start, end, text: sourceInput.value.slice(start, end) };
  }
  function currentLineBounds() {
    const source = sourceInput.value;
    const cursor = sourceInput.selectionStart;
    const start = source.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
    const nextBreak = source.indexOf("\n", cursor);
    return { start, end: nextBreak === -1 ? source.length : nextBreak };
  }
  function replaceRange(start, end, inserted, selectStart, selectEnd) {
    const source = sourceInput.value;
    sourceInput.value = `${source.slice(0, start)}${inserted}${source.slice(end)}`;
    localStorage.setItem(storageKey, sourceInput.value);
    sourceInput.focus();
    sourceInput.setSelectionRange(selectStart, selectEnd);
    renderCurrent();
  }
  function renderCurrent() {
    const source = sourceInput.value;
    try {
      const doc = parse(source, { filename: "workbench.noma" });
      const diagnostics = validate(doc);
      const themeCss = `${default_default}
body { background: #ffffff; }`;
      const htmlOptions = {
        standalone: true,
        themeCss,
        allowEscapeHatches: false,
        externalAssets: false,
        interactive: false
      };
      state = {
        doc,
        diagnostics,
        html: renderHtml(doc, htmlOptions),
        previewHtml: renderHtml(doc, { ...htmlOptions, sourcePositions: true }),
        json: renderJson(doc),
        llm: renderLlm(doc)
      };
    } catch (error) {
      state = {
        ...emptyState(),
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
    renderStatus();
    renderDiagnostics();
    renderOutline();
    renderOutput();
    updateFindStatus();
  }
  function renderStatus() {
    if (state.error) {
      statusText.textContent = state.error.message;
      statusText.dataset.state = "error";
      return;
    }
    const errors = state.diagnostics.filter((item) => item.severity === "error").length;
    const warnings = state.diagnostics.filter((item) => item.severity === "warning").length;
    const ids = state.doc ? countIds(state.doc) : 0;
    statusText.textContent = `${errors} errors / ${warnings} warnings / ${ids} IDs`;
    statusText.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";
  }
  function renderDiagnostics() {
    diagnosticsList.replaceChildren();
    if (state.error) {
      diagnosticsList.append(diagnosticRow("error", "render", state.error.message));
      return;
    }
    if (state.diagnostics.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No diagnostics";
      diagnosticsList.append(empty);
      return;
    }
    for (const item of state.diagnostics) {
      const row = diagnosticRow(item.severity, item.code, item.message, item.pos?.line);
      diagnosticsList.append(row);
    }
  }
  function diagnosticRow(severity, code, message, line) {
    const row = document.createElement(line ? "button" : "div");
    row.className = `diagnostic diagnostic-${severity}`;
    if (line && row instanceof HTMLButtonElement) {
      row.type = "button";
      row.addEventListener("click", () => jumpToLine(line));
    }
    const meta = document.createElement("span");
    meta.className = "diagnostic-meta";
    meta.textContent = line ? `${severity} / ${code} / line ${line}` : `${severity} / ${code}`;
    const body = document.createElement("span");
    body.className = "diagnostic-body";
    body.textContent = message;
    row.append(meta, body);
    return row;
  }
  function renderOutline() {
    outlineList.replaceChildren();
    if (!state.doc) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No outline";
      outlineList.append(empty);
      return;
    }
    const items = collectOutline(state.doc);
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No headings or IDs";
      outlineList.append(empty);
      return;
    }
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-item";
      button.style.setProperty("--depth", String(Math.max(0, item.level - 1)));
      if (item.line) button.addEventListener("click", () => jumpToLine(item.line));
      const label = document.createElement("span");
      label.className = "outline-label";
      label.textContent = item.label;
      const meta = document.createElement("span");
      meta.className = "outline-meta";
      meta.textContent = item.id ? `${item.kind} / ${item.id}` : item.kind;
      button.append(label, meta);
      outlineList.append(button);
    }
  }
  function renderOutput() {
    for (const button of targetButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.target === outputMode));
    }
    previewEditToggle.setAttribute("aria-pressed", String(previewEditMode));
    previewFrame.hidden = outputMode !== "preview";
    previewFrame.dataset.editing = String(previewEditMode && outputMode === "preview" && !state.error);
    outputPre.hidden = outputMode === "preview";
    if (outputMode === "preview") {
      previewFrame.srcdoc = state.error ? errorDocument(state.error.message) : state.previewHtml;
      return;
    }
    outputPre.textContent = outputMode === "json" ? state.json : state.llm;
  }
  function installPreviewEditing() {
    if (!previewEditMode || outputMode !== "preview" || state.error) return;
    const previewDoc = previewFrame.contentDocument;
    if (!previewDoc) return;
    const style = previewDoc.createElement("style");
    style.textContent = previewEditCss();
    previewDoc.head.append(style);
    const editableNodes = [...previewDoc.querySelectorAll("[data-noma-editable]")];
    for (const element of editableNodes) {
      const kind = element.dataset.nomaEditable;
      if (!isPreviewEditKind(kind)) continue;
      element.contentEditable = "true";
      element.spellcheck = true;
      element.dataset.nomaOriginalText = editableText(element);
      element.title = "Edit rendered text; blur to sync source";
      element.addEventListener("focus", () => {
        element.dataset.nomaEditing = "true";
      });
      element.addEventListener("blur", () => {
        delete element.dataset.nomaEditing;
        commitPreviewEdit(element);
      });
      element.addEventListener("keydown", (event) => handlePreviewEditKeydown(event, element));
      element.addEventListener("paste", (event) => pastePlainText(event, element));
    }
  }
  function previewEditCss() {
    return `
[data-noma-editable][contenteditable="true"] {
  cursor: text;
  outline: 1px dashed rgba(39, 93, 103, 0.38);
  outline-offset: 4px;
  border-radius: 2px;
}
[data-noma-editable][contenteditable="true"]:hover {
  outline-color: rgba(39, 93, 103, 0.62);
}
[data-noma-editable][data-noma-editing="true"] {
  background: rgba(232, 246, 239, 0.72);
  outline: 2px solid #275d67;
}
`;
  }
  function handlePreviewEditKeydown(event, element) {
    const kind = element.dataset.nomaEditable;
    const key = event.key.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      element.textContent = element.dataset.nomaOriginalText ?? "";
      element.blur();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "s") {
      event.preventDefault();
      element.blur();
      downloadText("document.noma", sourceInput.value, "text/plain");
      return;
    }
    if (key === "enter" && !event.shiftKey && (kind === "section" || kind === "list_item")) {
      event.preventDefault();
      element.blur();
    }
  }
  function pastePlainText(event, element) {
    const text = event.clipboardData?.getData("text/plain");
    if (text === void 0) return;
    event.preventDefault();
    element.ownerDocument.execCommand("insertText", false, text);
  }
  function commitPreviewEdit(element) {
    const originalText = element.dataset.nomaOriginalText ?? "";
    const nextText = editableText(element);
    if (nextText === originalText) return;
    const kind = element.dataset.nomaEditable;
    const line = positiveInt(element.dataset.nomaLine);
    const endLine = positiveInt(element.dataset.nomaEndLine) ?? line;
    if (!isPreviewEditKind(kind) || line === void 0) {
      showTransientStatus("Rendered edit cannot sync", "warning");
      return;
    }
    const replacement = previewSourceReplacement(kind, line, endLine, nextText);
    if (replacement === null) {
      showTransientStatus("Rendered edit cannot sync", "warning");
      return;
    }
    replaceSourceLines(line, endLine, replacement);
    showTransientStatus("Synced rendered edit");
  }
  function editableText(element) {
    return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
  }
  function previewSourceReplacement(kind, line, endLine, text) {
    const lines = sourceInput.value.split("\n");
    const currentLine = lines[line - 1];
    if (currentLine === void 0) return null;
    switch (kind) {
      case "section": {
        const match = /^(#{1,6}\s+)(.*?)(\s+\{[^}]+\})?\s*$/.exec(currentLine);
        if (!match) return null;
        const prefix = match[1] ?? "";
        const attrs = match[3] ?? "";
        return `${prefix}${normalizeInlineText(text) || "Untitled"}${attrs}`;
      }
      case "paragraph":
        return normalizeBlockText(text);
      case "list_item": {
        const match = /^(\s*(?:[-*]|\d+\.)\s+)(.*)$/.exec(currentLine);
        if (!match) return null;
        const prefix = match[1] ?? "";
        return `${prefix}${normalizeInlineText(text)}`;
      }
      case "quote": {
        const body = normalizeBlockText(text);
        const quoteLines = body ? body.split("\n") : [""];
        return quoteLines.map((quoteLine) => `> ${quoteLine}`).join("\n");
      }
    }
  }
  function normalizeInlineText(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function normalizeBlockText(text) {
    return text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
  }
  function replaceSourceLines(startLine, endLine, replacement) {
    if (renderTimer !== void 0) {
      window.clearTimeout(renderTimer);
      renderTimer = void 0;
    }
    const lines = sourceInput.value.split("\n");
    const startIndex = startLine - 1;
    const endIndex = Math.max(startIndex, Math.min(lines.length - 1, endLine - 1));
    lines.splice(startIndex, endIndex - startIndex + 1, ...replacement.split("\n"));
    sourceInput.value = lines.join("\n");
    localStorage.setItem(storageKey, sourceInput.value);
    renderCurrent();
  }
  function positiveInt(value) {
    if (!value) return void 0;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : void 0;
  }
  function isPreviewEditKind(value) {
    return value === "section" || value === "paragraph" || value === "list_item" || value === "quote";
  }
  function collectOutline(doc) {
    const out = [];
    for (const node of walk(doc)) {
      if (node.type === "document" || node.type === "frontmatter") continue;
      if (node.type === "section") {
        out.push(sectionOutline(node));
        continue;
      }
      if (node.type === "directive" && node.id) out.push(directiveOutline(node));
    }
    return out;
  }
  function sectionOutline(node) {
    return {
      id: node.id,
      label: node.title,
      kind: `h${node.level}`,
      line: node.pos?.line,
      level: node.level
    };
  }
  function directiveOutline(node) {
    return {
      id: node.id,
      label: directiveLabel(node),
      kind: `::${node.name}`,
      line: node.pos?.line,
      level: 2
    };
  }
  function directiveLabel(node) {
    const title = textAttr(node, "title") ?? textAttr(node, "label") ?? textAttr(node, "name");
    return title || node.id || node.name;
  }
  function textAttr(node, key) {
    const value = node.attrs[key];
    return typeof value === "string" && value.trim() ? value.trim() : void 0;
  }
  function countIds(doc) {
    let count = 0;
    for (const node of walk(doc)) {
      if (node.id) count++;
    }
    return count;
  }
  function jumpToLine(line) {
    const lines = sourceInput.value.split("\n");
    const clamped = Math.max(1, Math.min(line, lines.length));
    let start = 0;
    for (let i = 0; i < clamped - 1; i++) start += lines[i].length + 1;
    const end = start + lines[clamped - 1].length;
    sourceInput.focus();
    sourceInput.setSelectionRange(start, end);
  }
  function findInSource(direction) {
    const matches = findMatches();
    if (matches.length === 0) {
      updateFindStatus();
      return;
    }
    const cursor = direction === 1 ? sourceInput.selectionEnd : sourceInput.selectionStart;
    const index = direction === 1 ? nextMatchIndex(matches, cursor) : previousMatchIndex(matches, cursor);
    const match = matches[index];
    sourceInput.focus();
    sourceInput.setSelectionRange(match.start, match.end);
    findStatus.textContent = `${index + 1}/${matches.length}`;
  }
  function updateFindStatus() {
    const matches = findMatches();
    if (matches.length === 0) {
      findStatus.textContent = "0/0";
      return;
    }
    const active = matches.findIndex((match) => match.start === sourceInput.selectionStart && match.end === sourceInput.selectionEnd);
    findStatus.textContent = active >= 0 ? `${active + 1}/${matches.length}` : `0/${matches.length}`;
  }
  function findMatches() {
    const query = findInput.value;
    if (!query) return [];
    const source = sourceInput.value.toLowerCase();
    const needle = query.toLowerCase();
    const matches = [];
    let index = source.indexOf(needle);
    while (index !== -1) {
      matches.push({ start: index, end: index + needle.length });
      index = source.indexOf(needle, index + Math.max(1, needle.length));
    }
    return matches;
  }
  function nextMatchIndex(matches, cursor) {
    const next = matches.findIndex((match) => match.start >= cursor);
    return next === -1 ? 0 : next;
  }
  function previousMatchIndex(matches, cursor) {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].end <= cursor) return i;
    }
    return matches.length - 1;
  }
  function printPreview() {
    if (outputMode !== "preview") {
      outputMode = "preview";
      renderOutput();
    }
    try {
      const win = previewFrame.contentWindow;
      if (!win) {
        showTransientStatus("Preview unavailable", "warning");
        return;
      }
      win.focus();
      win.print();
      showTransientStatus("Print dialog requested");
    } catch {
      showTransientStatus("Preview print blocked by browser", "warning");
    }
  }
  function downloadText(filename, text, type2) {
    const blob = new Blob([text], { type: type2 });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  async function copyText(text, message) {
    if (!navigator.clipboard) {
      statusText.textContent = "Clipboard API unavailable";
      statusText.dataset.state = "warning";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showTransientStatus(message);
    } catch {
      showTransientStatus("Clipboard write blocked by browser", "warning");
    }
  }
  function showTransientStatus(message, stateName = "ok") {
    const previous = statusText.textContent ?? "";
    const previousState = statusText.dataset.state;
    statusText.textContent = message;
    statusText.dataset.state = stateName;
    window.setTimeout(() => {
      statusText.textContent = previous;
      if (previousState) statusText.dataset.state = previousState;
    }, 1300);
  }
  function emptyState() {
    return {
      doc: null,
      diagnostics: [],
      html: "",
      previewHtml: "",
      json: "",
      llm: ""
    };
  }
  function errorDocument(message) {
    return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<style>
body { margin: 0; font: 15px system-ui, sans-serif; color: #2f1b18; background: #fff8f6; }
main { padding: 24px; }
pre { white-space: pre-wrap; }
</style>
<main><h1>Render error</h1><pre>${escapeHtml2(message)}</pre></main>
</html>`;
  }
  function escapeHtml2(value) {
    return value.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }
})();
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 4.1.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
