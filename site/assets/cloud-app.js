"use strict";
(() => {
  // src/ast.ts
  var isDirective = (n) => n.type === "directive";
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
  function generateError(state, message) {
    var mark = {
      name: state.filename,
      buffer: state.input.slice(0, -1),
      // omit trailing \0
      position: state.position,
      line: state.line,
      column: state.position - state.lineStart
    };
    mark.snippet = snippet(mark);
    return new exception(message, mark);
  }
  function throwError(state, message) {
    throw generateError(state, message);
  }
  function throwWarning(state, message) {
    if (state.onWarning) {
      state.onWarning.call(null, generateError(state, message));
    }
  }
  var directiveHandlers = {
    YAML: function handleYamlDirective(state, name, args) {
      var match, major, minor;
      if (state.version !== null) {
        throwError(state, "duplication of %YAML directive");
      }
      if (args.length !== 1) {
        throwError(state, "YAML directive accepts exactly one argument");
      }
      match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
      if (match === null) {
        throwError(state, "ill-formed argument of the YAML directive");
      }
      major = parseInt(match[1], 10);
      minor = parseInt(match[2], 10);
      if (major !== 1) {
        throwError(state, "unacceptable YAML version of the document");
      }
      state.version = args[0];
      state.checkLineBreaks = minor < 2;
      if (minor !== 1 && minor !== 2) {
        throwWarning(state, "unsupported YAML version of the document");
      }
    },
    TAG: function handleTagDirective(state, name, args) {
      var handle, prefix;
      if (args.length !== 2) {
        throwError(state, "TAG directive accepts exactly two arguments");
      }
      handle = args[0];
      prefix = args[1];
      if (!PATTERN_TAG_HANDLE.test(handle)) {
        throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
      }
      if (_hasOwnProperty$1.call(state.tagMap, handle)) {
        throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
      }
      if (!PATTERN_TAG_URI.test(prefix)) {
        throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
      }
      try {
        prefix = decodeURIComponent(prefix);
      } catch (err) {
        throwError(state, "tag prefix is malformed: " + prefix);
      }
      state.tagMap[handle] = prefix;
    }
  };
  function captureSegment(state, start, end, checkJson) {
    var _position, _length, _character, _result;
    if (start < end) {
      _result = state.input.slice(start, end);
      if (checkJson) {
        for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
          _character = _result.charCodeAt(_position);
          if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
            throwError(state, "expected valid JSON character");
          }
        }
      } else if (PATTERN_NON_PRINTABLE.test(_result)) {
        throwError(state, "the stream contains non-printable characters");
      }
      state.result += _result;
    }
  }
  function mergeMappings(state, destination, source, overridableKeys) {
    var sourceKeys, key, index, quantity;
    if (!common.isObject(source)) {
      throwError(state, "cannot merge mappings; the provided source object is unacceptable");
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
  function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startLineStart, startPos) {
    var index, quantity;
    if (Array.isArray(keyNode)) {
      keyNode = Array.prototype.slice.call(keyNode);
      for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
        if (Array.isArray(keyNode[index])) {
          throwError(state, "nested arrays are not supported inside keys");
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
          mergeMappings(state, _result, valueNode[index], overridableKeys);
        }
      } else {
        mergeMappings(state, _result, valueNode, overridableKeys);
      }
    } else {
      if (!state.json && !_hasOwnProperty$1.call(overridableKeys, keyNode) && _hasOwnProperty$1.call(_result, keyNode)) {
        state.line = startLine || state.line;
        state.lineStart = startLineStart || state.lineStart;
        state.position = startPos || state.position;
        throwError(state, "duplicated mapping key");
      }
      setProperty(_result, keyNode, valueNode);
      delete overridableKeys[keyNode];
    }
    return _result;
  }
  function readLineBreak(state) {
    var ch;
    ch = state.input.charCodeAt(state.position);
    if (ch === 10) {
      state.position++;
    } else if (ch === 13) {
      state.position++;
      if (state.input.charCodeAt(state.position) === 10) {
        state.position++;
      }
    } else {
      throwError(state, "a line break is expected");
    }
    state.line += 1;
    state.lineStart = state.position;
    state.firstTabInLine = -1;
  }
  function skipSeparationSpace(state, allowComments, checkIndent) {
    var lineBreaks = 0, ch = state.input.charCodeAt(state.position);
    while (ch !== 0) {
      while (is_WHITE_SPACE(ch)) {
        if (ch === 9 && state.firstTabInLine === -1) {
          state.firstTabInLine = state.position;
        }
        ch = state.input.charCodeAt(++state.position);
      }
      if (allowComments && ch === 35) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (ch !== 10 && ch !== 13 && ch !== 0);
      }
      if (is_EOL(ch)) {
        readLineBreak(state);
        ch = state.input.charCodeAt(state.position);
        lineBreaks++;
        state.lineIndent = 0;
        while (ch === 32) {
          state.lineIndent++;
          ch = state.input.charCodeAt(++state.position);
        }
      } else {
        break;
      }
    }
    if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
      throwWarning(state, "deficient indentation");
    }
    return lineBreaks;
  }
  function testDocumentSeparator(state) {
    var _position = state.position, ch;
    ch = state.input.charCodeAt(_position);
    if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
      _position += 3;
      ch = state.input.charCodeAt(_position);
      if (ch === 0 || is_WS_OR_EOL(ch)) {
        return true;
      }
    }
    return false;
  }
  function writeFoldedLines(state, count) {
    if (count === 1) {
      state.result += " ";
    } else if (count > 1) {
      state.result += common.repeat("\n", count - 1);
    }
  }
  function readPlainScalar(state, nodeIndent, withinFlowCollection) {
    var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state.kind, _result = state.result, ch;
    ch = state.input.charCodeAt(state.position);
    if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
      return false;
    }
    if (ch === 63 || ch === 45) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
        return false;
      }
    }
    state.kind = "scalar";
    state.result = "";
    captureStart = captureEnd = state.position;
    hasPendingContent = false;
    while (ch !== 0) {
      if (ch === 58) {
        following = state.input.charCodeAt(state.position + 1);
        if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
          break;
        }
      } else if (ch === 35) {
        preceding = state.input.charCodeAt(state.position - 1);
        if (is_WS_OR_EOL(preceding)) {
          break;
        }
      } else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
        break;
      } else if (is_EOL(ch)) {
        _line = state.line;
        _lineStart = state.lineStart;
        _lineIndent = state.lineIndent;
        skipSeparationSpace(state, false, -1);
        if (state.lineIndent >= nodeIndent) {
          hasPendingContent = true;
          ch = state.input.charCodeAt(state.position);
          continue;
        } else {
          state.position = captureEnd;
          state.line = _line;
          state.lineStart = _lineStart;
          state.lineIndent = _lineIndent;
          break;
        }
      }
      if (hasPendingContent) {
        captureSegment(state, captureStart, captureEnd, false);
        writeFoldedLines(state, state.line - _line);
        captureStart = captureEnd = state.position;
        hasPendingContent = false;
      }
      if (!is_WHITE_SPACE(ch)) {
        captureEnd = state.position + 1;
      }
      ch = state.input.charCodeAt(++state.position);
    }
    captureSegment(state, captureStart, captureEnd, false);
    if (state.result) {
      return true;
    }
    state.kind = _kind;
    state.result = _result;
    return false;
  }
  function readSingleQuotedScalar(state, nodeIndent) {
    var ch, captureStart, captureEnd;
    ch = state.input.charCodeAt(state.position);
    if (ch !== 39) {
      return false;
    }
    state.kind = "scalar";
    state.result = "";
    state.position++;
    captureStart = captureEnd = state.position;
    while ((ch = state.input.charCodeAt(state.position)) !== 0) {
      if (ch === 39) {
        captureSegment(state, captureStart, state.position, true);
        ch = state.input.charCodeAt(++state.position);
        if (ch === 39) {
          captureStart = state.position;
          state.position++;
          captureEnd = state.position;
        } else {
          return true;
        }
      } else if (is_EOL(ch)) {
        captureSegment(state, captureStart, captureEnd, true);
        writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
        captureStart = captureEnd = state.position;
      } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
        throwError(state, "unexpected end of the document within a single quoted scalar");
      } else {
        state.position++;
        captureEnd = state.position;
      }
    }
    throwError(state, "unexpected end of the stream within a single quoted scalar");
  }
  function readDoubleQuotedScalar(state, nodeIndent) {
    var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
    ch = state.input.charCodeAt(state.position);
    if (ch !== 34) {
      return false;
    }
    state.kind = "scalar";
    state.result = "";
    state.position++;
    captureStart = captureEnd = state.position;
    while ((ch = state.input.charCodeAt(state.position)) !== 0) {
      if (ch === 34) {
        captureSegment(state, captureStart, state.position, true);
        state.position++;
        return true;
      } else if (ch === 92) {
        captureSegment(state, captureStart, state.position, true);
        ch = state.input.charCodeAt(++state.position);
        if (is_EOL(ch)) {
          skipSeparationSpace(state, false, nodeIndent);
        } else if (ch < 256 && simpleEscapeCheck[ch]) {
          state.result += simpleEscapeMap[ch];
          state.position++;
        } else if ((tmp = escapedHexLen(ch)) > 0) {
          hexLength = tmp;
          hexResult = 0;
          for (; hexLength > 0; hexLength--) {
            ch = state.input.charCodeAt(++state.position);
            if ((tmp = fromHexCode(ch)) >= 0) {
              hexResult = (hexResult << 4) + tmp;
            } else {
              throwError(state, "expected hexadecimal character");
            }
          }
          state.result += charFromCodepoint(hexResult);
          state.position++;
        } else {
          throwError(state, "unknown escape sequence");
        }
        captureStart = captureEnd = state.position;
      } else if (is_EOL(ch)) {
        captureSegment(state, captureStart, captureEnd, true);
        writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
        captureStart = captureEnd = state.position;
      } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
        throwError(state, "unexpected end of the document within a double quoted scalar");
      } else {
        state.position++;
        captureEnd = state.position;
      }
    }
    throwError(state, "unexpected end of the stream within a double quoted scalar");
  }
  function readFlowCollection(state, nodeIndent) {
    var readNext = true, _line, _lineStart, _pos, _tag = state.tag, _result, _anchor = state.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = /* @__PURE__ */ Object.create(null), keyNode, keyTag, valueNode, ch;
    ch = state.input.charCodeAt(state.position);
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
    if (state.anchor !== null) {
      state.anchorMap[state.anchor] = _result;
    }
    ch = state.input.charCodeAt(++state.position);
    while (ch !== 0) {
      skipSeparationSpace(state, true, nodeIndent);
      ch = state.input.charCodeAt(state.position);
      if (ch === terminator) {
        state.position++;
        state.tag = _tag;
        state.anchor = _anchor;
        state.kind = isMapping ? "mapping" : "sequence";
        state.result = _result;
        return true;
      } else if (!readNext) {
        throwError(state, "missed comma between flow collection entries");
      } else if (ch === 44) {
        throwError(state, "expected the node content, but found ','");
      }
      keyTag = keyNode = valueNode = null;
      isPair = isExplicitPair = false;
      if (ch === 63) {
        following = state.input.charCodeAt(state.position + 1);
        if (is_WS_OR_EOL(following)) {
          isPair = isExplicitPair = true;
          state.position++;
          skipSeparationSpace(state, true, nodeIndent);
        }
      }
      _line = state.line;
      _lineStart = state.lineStart;
      _pos = state.position;
      composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
      keyTag = state.tag;
      keyNode = state.result;
      skipSeparationSpace(state, true, nodeIndent);
      ch = state.input.charCodeAt(state.position);
      if ((isExplicitPair || state.line === _line) && ch === 58) {
        isPair = true;
        ch = state.input.charCodeAt(++state.position);
        skipSeparationSpace(state, true, nodeIndent);
        composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
        valueNode = state.result;
      }
      if (isMapping) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
      } else if (isPair) {
        _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
      } else {
        _result.push(keyNode);
      }
      skipSeparationSpace(state, true, nodeIndent);
      ch = state.input.charCodeAt(state.position);
      if (ch === 44) {
        readNext = true;
        ch = state.input.charCodeAt(++state.position);
      } else {
        readNext = false;
      }
    }
    throwError(state, "unexpected end of the stream within a flow collection");
  }
  function readBlockScalar(state, nodeIndent) {
    var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
    ch = state.input.charCodeAt(state.position);
    if (ch === 124) {
      folding = false;
    } else if (ch === 62) {
      folding = true;
    } else {
      return false;
    }
    state.kind = "scalar";
    state.result = "";
    while (ch !== 0) {
      ch = state.input.charCodeAt(++state.position);
      if (ch === 43 || ch === 45) {
        if (CHOMPING_CLIP === chomping) {
          chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
        } else {
          throwError(state, "repeat of a chomping mode identifier");
        }
      } else if ((tmp = fromDecimalCode(ch)) >= 0) {
        if (tmp === 0) {
          throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
        } else if (!detectedIndent) {
          textIndent = nodeIndent + tmp - 1;
          detectedIndent = true;
        } else {
          throwError(state, "repeat of an indentation width identifier");
        }
      } else {
        break;
      }
    }
    if (is_WHITE_SPACE(ch)) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (is_WHITE_SPACE(ch));
      if (ch === 35) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (!is_EOL(ch) && ch !== 0);
      }
    }
    while (ch !== 0) {
      readLineBreak(state);
      state.lineIndent = 0;
      ch = state.input.charCodeAt(state.position);
      while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
        state.lineIndent++;
        ch = state.input.charCodeAt(++state.position);
      }
      if (!detectedIndent && state.lineIndent > textIndent) {
        textIndent = state.lineIndent;
      }
      if (is_EOL(ch)) {
        emptyLines++;
        continue;
      }
      if (state.lineIndent < textIndent) {
        if (chomping === CHOMPING_KEEP) {
          state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
        } else if (chomping === CHOMPING_CLIP) {
          if (didReadContent) {
            state.result += "\n";
          }
        }
        break;
      }
      if (folding) {
        if (is_WHITE_SPACE(ch)) {
          atMoreIndented = true;
          state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
        } else if (atMoreIndented) {
          atMoreIndented = false;
          state.result += common.repeat("\n", emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didReadContent) {
            state.result += " ";
          }
        } else {
          state.result += common.repeat("\n", emptyLines);
        }
      } else {
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      }
      didReadContent = true;
      detectedIndent = true;
      emptyLines = 0;
      captureStart = state.position;
      while (!is_EOL(ch) && ch !== 0) {
        ch = state.input.charCodeAt(++state.position);
      }
      captureSegment(state, captureStart, state.position, false);
    }
    return true;
  }
  function readBlockSequence(state, nodeIndent) {
    var _line, _tag = state.tag, _anchor = state.anchor, _result = [], following, detected = false, ch;
    if (state.firstTabInLine !== -1) return false;
    if (state.anchor !== null) {
      state.anchorMap[state.anchor] = _result;
    }
    ch = state.input.charCodeAt(state.position);
    while (ch !== 0) {
      if (state.firstTabInLine !== -1) {
        state.position = state.firstTabInLine;
        throwError(state, "tab characters must not be used in indentation");
      }
      if (ch !== 45) {
        break;
      }
      following = state.input.charCodeAt(state.position + 1);
      if (!is_WS_OR_EOL(following)) {
        break;
      }
      detected = true;
      state.position++;
      if (skipSeparationSpace(state, true, -1)) {
        if (state.lineIndent <= nodeIndent) {
          _result.push(null);
          ch = state.input.charCodeAt(state.position);
          continue;
        }
      }
      _line = state.line;
      composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
      _result.push(state.result);
      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
      if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
        throwError(state, "bad indentation of a sequence entry");
      } else if (state.lineIndent < nodeIndent) {
        break;
      }
    }
    if (detected) {
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = "sequence";
      state.result = _result;
      return true;
    }
    return false;
  }
  function readBlockMapping(state, nodeIndent, flowIndent) {
    var following, allowCompact, _line, _keyLine, _keyLineStart, _keyPos, _tag = state.tag, _anchor = state.anchor, _result = {}, overridableKeys = /* @__PURE__ */ Object.create(null), keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
    if (state.firstTabInLine !== -1) return false;
    if (state.anchor !== null) {
      state.anchorMap[state.anchor] = _result;
    }
    ch = state.input.charCodeAt(state.position);
    while (ch !== 0) {
      if (!atExplicitKey && state.firstTabInLine !== -1) {
        state.position = state.firstTabInLine;
        throwError(state, "tab characters must not be used in indentation");
      }
      following = state.input.charCodeAt(state.position + 1);
      _line = state.line;
      if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
        if (ch === 63) {
          if (atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }
          detected = true;
          atExplicitKey = true;
          allowCompact = true;
        } else if (atExplicitKey) {
          atExplicitKey = false;
          allowCompact = true;
        } else {
          throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
        }
        state.position += 1;
        ch = following;
      } else {
        _keyLine = state.line;
        _keyLineStart = state.lineStart;
        _keyPos = state.position;
        if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
          break;
        }
        if (state.line === _line) {
          ch = state.input.charCodeAt(state.position);
          while (is_WHITE_SPACE(ch)) {
            ch = state.input.charCodeAt(++state.position);
          }
          if (ch === 58) {
            ch = state.input.charCodeAt(++state.position);
            if (!is_WS_OR_EOL(ch)) {
              throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
            }
            if (atExplicitKey) {
              storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
              keyTag = keyNode = valueNode = null;
            }
            detected = true;
            atExplicitKey = false;
            allowCompact = false;
            keyTag = state.tag;
            keyNode = state.result;
          } else if (detected) {
            throwError(state, "can not read an implicit mapping pair; a colon is missed");
          } else {
            state.tag = _tag;
            state.anchor = _anchor;
            return true;
          }
        } else if (detected) {
          throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
        } else {
          state.tag = _tag;
          state.anchor = _anchor;
          return true;
        }
      }
      if (state.line === _line || state.lineIndent > nodeIndent) {
        if (atExplicitKey) {
          _keyLine = state.line;
          _keyLineStart = state.lineStart;
          _keyPos = state.position;
        }
        if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
          if (atExplicitKey) {
            keyNode = state.result;
          } else {
            valueNode = state.result;
          }
        }
        if (!atExplicitKey) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }
        skipSeparationSpace(state, true, -1);
        ch = state.input.charCodeAt(state.position);
      }
      if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
        throwError(state, "bad indentation of a mapping entry");
      } else if (state.lineIndent < nodeIndent) {
        break;
      }
    }
    if (atExplicitKey) {
      storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
    }
    if (detected) {
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = "mapping";
      state.result = _result;
    }
    return detected;
  }
  function readTagProperty(state) {
    var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
    ch = state.input.charCodeAt(state.position);
    if (ch !== 33) return false;
    if (state.tag !== null) {
      throwError(state, "duplication of a tag property");
    }
    ch = state.input.charCodeAt(++state.position);
    if (ch === 60) {
      isVerbatim = true;
      ch = state.input.charCodeAt(++state.position);
    } else if (ch === 33) {
      isNamed = true;
      tagHandle = "!!";
      ch = state.input.charCodeAt(++state.position);
    } else {
      tagHandle = "!";
    }
    _position = state.position;
    if (isVerbatim) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (ch !== 0 && ch !== 62);
      if (state.position < state.length) {
        tagName = state.input.slice(_position, state.position);
        ch = state.input.charCodeAt(++state.position);
      } else {
        throwError(state, "unexpected end of the stream within a verbatim tag");
      }
    } else {
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        if (ch === 33) {
          if (!isNamed) {
            tagHandle = state.input.slice(_position - 1, state.position + 1);
            if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
              throwError(state, "named tag handle cannot contain such characters");
            }
            isNamed = true;
            _position = state.position + 1;
          } else {
            throwError(state, "tag suffix cannot contain exclamation marks");
          }
        }
        ch = state.input.charCodeAt(++state.position);
      }
      tagName = state.input.slice(_position, state.position);
      if (PATTERN_FLOW_INDICATORS.test(tagName)) {
        throwError(state, "tag suffix cannot contain flow indicator characters");
      }
    }
    if (tagName && !PATTERN_TAG_URI.test(tagName)) {
      throwError(state, "tag name cannot contain such characters: " + tagName);
    }
    try {
      tagName = decodeURIComponent(tagName);
    } catch (err) {
      throwError(state, "tag name is malformed: " + tagName);
    }
    if (isVerbatim) {
      state.tag = tagName;
    } else if (_hasOwnProperty$1.call(state.tagMap, tagHandle)) {
      state.tag = state.tagMap[tagHandle] + tagName;
    } else if (tagHandle === "!") {
      state.tag = "!" + tagName;
    } else if (tagHandle === "!!") {
      state.tag = "tag:yaml.org,2002:" + tagName;
    } else {
      throwError(state, 'undeclared tag handle "' + tagHandle + '"');
    }
    return true;
  }
  function readAnchorProperty(state) {
    var _position, ch;
    ch = state.input.charCodeAt(state.position);
    if (ch !== 38) return false;
    if (state.anchor !== null) {
      throwError(state, "duplication of an anchor property");
    }
    ch = state.input.charCodeAt(++state.position);
    _position = state.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
      ch = state.input.charCodeAt(++state.position);
    }
    if (state.position === _position) {
      throwError(state, "name of an anchor node must contain at least one character");
    }
    state.anchor = state.input.slice(_position, state.position);
    return true;
  }
  function readAlias(state) {
    var _position, alias, ch;
    ch = state.input.charCodeAt(state.position);
    if (ch !== 42) return false;
    ch = state.input.charCodeAt(++state.position);
    _position = state.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
      ch = state.input.charCodeAt(++state.position);
    }
    if (state.position === _position) {
      throwError(state, "name of an alias node must contain at least one character");
    }
    alias = state.input.slice(_position, state.position);
    if (!_hasOwnProperty$1.call(state.anchorMap, alias)) {
      throwError(state, 'unidentified alias "' + alias + '"');
    }
    state.result = state.anchorMap[alias];
    skipSeparationSpace(state, true, -1);
    return true;
  }
  function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
    var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, typeList, type2, flowIndent, blockIndent;
    if (state.listener !== null) {
      state.listener("open", state);
    }
    state.tag = null;
    state.anchor = null;
    state.kind = null;
    state.result = null;
    allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
    if (allowToSeek) {
      if (skipSeparationSpace(state, true, -1)) {
        atNewLine = true;
        if (state.lineIndent > parentIndent) {
          indentStatus = 1;
        } else if (state.lineIndent === parentIndent) {
          indentStatus = 0;
        } else if (state.lineIndent < parentIndent) {
          indentStatus = -1;
        }
      }
    }
    if (indentStatus === 1) {
      while (readTagProperty(state) || readAnchorProperty(state)) {
        if (skipSeparationSpace(state, true, -1)) {
          atNewLine = true;
          allowBlockCollections = allowBlockStyles;
          if (state.lineIndent > parentIndent) {
            indentStatus = 1;
          } else if (state.lineIndent === parentIndent) {
            indentStatus = 0;
          } else if (state.lineIndent < parentIndent) {
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
      blockIndent = state.position - state.lineStart;
      if (indentStatus === 1) {
        if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) {
          hasContent = true;
        } else {
          if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) {
            hasContent = true;
          } else if (readAlias(state)) {
            hasContent = true;
            if (state.tag !== null || state.anchor !== null) {
              throwError(state, "alias node should not have any properties");
            }
          } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
            hasContent = true;
            if (state.tag === null) {
              state.tag = "?";
            }
          }
          if (state.anchor !== null) {
            state.anchorMap[state.anchor] = state.result;
          }
        }
      } else if (indentStatus === 0) {
        hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
      }
    }
    if (state.tag === null) {
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = state.result;
      }
    } else if (state.tag === "?") {
      if (state.result !== null && state.kind !== "scalar") {
        throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
      }
      for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
        type2 = state.implicitTypes[typeIndex];
        if (type2.resolve(state.result)) {
          state.result = type2.construct(state.result);
          state.tag = type2.tag;
          if (state.anchor !== null) {
            state.anchorMap[state.anchor] = state.result;
          }
          break;
        }
      }
    } else if (state.tag !== "!") {
      if (_hasOwnProperty$1.call(state.typeMap[state.kind || "fallback"], state.tag)) {
        type2 = state.typeMap[state.kind || "fallback"][state.tag];
      } else {
        type2 = null;
        typeList = state.typeMap.multi[state.kind || "fallback"];
        for (typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) {
          if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
            type2 = typeList[typeIndex];
            break;
          }
        }
      }
      if (!type2) {
        throwError(state, "unknown tag !<" + state.tag + ">");
      }
      if (state.result !== null && type2.kind !== state.kind) {
        throwError(state, "unacceptable node kind for !<" + state.tag + '> tag; it should be "' + type2.kind + '", not "' + state.kind + '"');
      }
      if (!type2.resolve(state.result, state.tag)) {
        throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
      } else {
        state.result = type2.construct(state.result, state.tag);
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
      }
    }
    if (state.listener !== null) {
      state.listener("close", state);
    }
    return state.tag !== null || state.anchor !== null || hasContent;
  }
  function readDocument(state) {
    var documentStart = state.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
    state.version = null;
    state.checkLineBreaks = state.legacy;
    state.tagMap = /* @__PURE__ */ Object.create(null);
    state.anchorMap = /* @__PURE__ */ Object.create(null);
    while ((ch = state.input.charCodeAt(state.position)) !== 0) {
      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
      if (state.lineIndent > 0 || ch !== 37) {
        break;
      }
      hasDirectives = true;
      ch = state.input.charCodeAt(++state.position);
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      directiveName = state.input.slice(_position, state.position);
      directiveArgs = [];
      if (directiveName.length < 1) {
        throwError(state, "directive name must not be less than one character in length");
      }
      while (ch !== 0) {
        while (is_WHITE_SPACE(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        if (ch === 35) {
          do {
            ch = state.input.charCodeAt(++state.position);
          } while (ch !== 0 && !is_EOL(ch));
          break;
        }
        if (is_EOL(ch)) break;
        _position = state.position;
        while (ch !== 0 && !is_WS_OR_EOL(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        directiveArgs.push(state.input.slice(_position, state.position));
      }
      if (ch !== 0) readLineBreak(state);
      if (_hasOwnProperty$1.call(directiveHandlers, directiveName)) {
        directiveHandlers[directiveName](state, directiveName, directiveArgs);
      } else {
        throwWarning(state, 'unknown document directive "' + directiveName + '"');
      }
    }
    skipSeparationSpace(state, true, -1);
    if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
      state.position += 3;
      skipSeparationSpace(state, true, -1);
    } else if (hasDirectives) {
      throwError(state, "directives end mark is expected");
    }
    composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
    skipSeparationSpace(state, true, -1);
    if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
      throwWarning(state, "non-ASCII line breaks are interpreted as content");
    }
    state.documents.push(state.result);
    if (state.position === state.lineStart && testDocumentSeparator(state)) {
      if (state.input.charCodeAt(state.position) === 46) {
        state.position += 3;
        skipSeparationSpace(state, true, -1);
      }
      return;
    }
    if (state.position < state.length - 1) {
      throwError(state, "end of the stream or a document separator is expected");
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
    var state = new State$1(input, options);
    var nullpos = input.indexOf("\0");
    if (nullpos !== -1) {
      state.position = nullpos;
      throwError(state, "null byte is not allowed in input");
    }
    state.input += "\0";
    while (state.input.charCodeAt(state.position) === 32) {
      state.lineIndent += 1;
      state.position += 1;
    }
    while (state.position < state.length - 1) {
      readDocument(state);
    }
    return state.documents;
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
  function generateNextLine(state, level) {
    return "\n" + common.repeat(" ", state.indent * level);
  }
  function testImplicitResolving(state, str2) {
    var index, length, type2;
    for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
      type2 = state.implicitTypes[index];
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
  function writeScalar(state, string, level, iskey, inblock) {
    state.dump = (function() {
      if (string.length === 0) {
        return state.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''";
      }
      if (!state.noCompatMode) {
        if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) {
          return state.quotingType === QUOTING_TYPE_DOUBLE ? '"' + string + '"' : "'" + string + "'";
        }
      }
      var indent = state.indent * Math.max(1, level);
      var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
      var singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
      function testAmbiguity(string2) {
        return testImplicitResolving(state, string2);
      }
      switch (chooseScalarStyle(
        string,
        singleLineOnly,
        state.indent,
        lineWidth,
        testAmbiguity,
        state.quotingType,
        state.forceQuotes && !iskey,
        inblock
      )) {
        case STYLE_PLAIN:
          return string;
        case STYLE_SINGLE:
          return "'" + string.replace(/'/g, "''") + "'";
        case STYLE_LITERAL:
          return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
        case STYLE_FOLDED:
          return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
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
  function writeFlowSequence(state, level, object) {
    var _result = "", _tag = state.tag, index, length, value;
    for (index = 0, length = object.length; index < length; index += 1) {
      value = object[index];
      if (state.replacer) {
        value = state.replacer.call(object, String(index), value);
      }
      if (writeNode(state, level, value, false, false) || typeof value === "undefined" && writeNode(state, level, null, false, false)) {
        if (_result !== "") _result += "," + (!state.condenseFlow ? " " : "");
        _result += state.dump;
      }
    }
    state.tag = _tag;
    state.dump = "[" + _result + "]";
  }
  function writeBlockSequence(state, level, object, compact) {
    var _result = "", _tag = state.tag, index, length, value;
    for (index = 0, length = object.length; index < length; index += 1) {
      value = object[index];
      if (state.replacer) {
        value = state.replacer.call(object, String(index), value);
      }
      if (writeNode(state, level + 1, value, true, true, false, true) || typeof value === "undefined" && writeNode(state, level + 1, null, true, true, false, true)) {
        if (!compact || _result !== "") {
          _result += generateNextLine(state, level);
        }
        if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
          _result += "-";
        } else {
          _result += "- ";
        }
        _result += state.dump;
      }
    }
    state.tag = _tag;
    state.dump = _result || "[]";
  }
  function writeFlowMapping(state, level, object) {
    var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
    for (index = 0, length = objectKeyList.length; index < length; index += 1) {
      pairBuffer = "";
      if (_result !== "") pairBuffer += ", ";
      if (state.condenseFlow) pairBuffer += '"';
      objectKey = objectKeyList[index];
      objectValue = object[objectKey];
      if (state.replacer) {
        objectValue = state.replacer.call(object, objectKey, objectValue);
      }
      if (!writeNode(state, level, objectKey, false, false)) {
        continue;
      }
      if (state.dump.length > 1024) pairBuffer += "? ";
      pairBuffer += state.dump + (state.condenseFlow ? '"' : "") + ":" + (state.condenseFlow ? "" : " ");
      if (!writeNode(state, level, objectValue, false, false)) {
        continue;
      }
      pairBuffer += state.dump;
      _result += pairBuffer;
    }
    state.tag = _tag;
    state.dump = "{" + _result + "}";
  }
  function writeBlockMapping(state, level, object, compact) {
    var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
    if (state.sortKeys === true) {
      objectKeyList.sort();
    } else if (typeof state.sortKeys === "function") {
      objectKeyList.sort(state.sortKeys);
    } else if (state.sortKeys) {
      throw new exception("sortKeys must be a boolean or a function");
    }
    for (index = 0, length = objectKeyList.length; index < length; index += 1) {
      pairBuffer = "";
      if (!compact || _result !== "") {
        pairBuffer += generateNextLine(state, level);
      }
      objectKey = objectKeyList[index];
      objectValue = object[objectKey];
      if (state.replacer) {
        objectValue = state.replacer.call(object, objectKey, objectValue);
      }
      if (!writeNode(state, level + 1, objectKey, true, true, true)) {
        continue;
      }
      explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
      if (explicitPair) {
        if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
          pairBuffer += "?";
        } else {
          pairBuffer += "? ";
        }
      }
      pairBuffer += state.dump;
      if (explicitPair) {
        pairBuffer += generateNextLine(state, level);
      }
      if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
        continue;
      }
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        pairBuffer += ":";
      } else {
        pairBuffer += ": ";
      }
      pairBuffer += state.dump;
      _result += pairBuffer;
    }
    state.tag = _tag;
    state.dump = _result || "{}";
  }
  function detectType(state, object, explicit) {
    var _result, typeList, index, length, type2, style;
    typeList = explicit ? state.explicitTypes : state.implicitTypes;
    for (index = 0, length = typeList.length; index < length; index += 1) {
      type2 = typeList[index];
      if ((type2.instanceOf || type2.predicate) && (!type2.instanceOf || typeof object === "object" && object instanceof type2.instanceOf) && (!type2.predicate || type2.predicate(object))) {
        if (explicit) {
          if (type2.multi && type2.representName) {
            state.tag = type2.representName(object);
          } else {
            state.tag = type2.tag;
          }
        } else {
          state.tag = "?";
        }
        if (type2.represent) {
          style = state.styleMap[type2.tag] || type2.defaultStyle;
          if (_toString.call(type2.represent) === "[object Function]") {
            _result = type2.represent(object, style);
          } else if (_hasOwnProperty.call(type2.represent, style)) {
            _result = type2.represent[style](object, style);
          } else {
            throw new exception("!<" + type2.tag + '> tag resolver accepts not "' + style + '" style');
          }
          state.dump = _result;
        }
        return true;
      }
    }
    return false;
  }
  function writeNode(state, level, object, block, compact, iskey, isblockseq) {
    state.tag = null;
    state.dump = object;
    if (!detectType(state, object, false)) {
      detectType(state, object, true);
    }
    var type2 = _toString.call(state.dump);
    var inblock = block;
    var tagStr;
    if (block) {
      block = state.flowLevel < 0 || state.flowLevel > level;
    }
    var objectOrArray = type2 === "[object Object]" || type2 === "[object Array]", duplicateIndex, duplicate;
    if (objectOrArray) {
      duplicateIndex = state.duplicates.indexOf(object);
      duplicate = duplicateIndex !== -1;
    }
    if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) {
      compact = false;
    }
    if (duplicate && state.usedDuplicates[duplicateIndex]) {
      state.dump = "*ref_" + duplicateIndex;
    } else {
      if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
        state.usedDuplicates[duplicateIndex] = true;
      }
      if (type2 === "[object Object]") {
        if (block && Object.keys(state.dump).length !== 0) {
          writeBlockMapping(state, level, state.dump, compact);
          if (duplicate) {
            state.dump = "&ref_" + duplicateIndex + state.dump;
          }
        } else {
          writeFlowMapping(state, level, state.dump);
          if (duplicate) {
            state.dump = "&ref_" + duplicateIndex + " " + state.dump;
          }
        }
      } else if (type2 === "[object Array]") {
        if (block && state.dump.length !== 0) {
          if (state.noArrayIndent && !isblockseq && level > 0) {
            writeBlockSequence(state, level - 1, state.dump, compact);
          } else {
            writeBlockSequence(state, level, state.dump, compact);
          }
          if (duplicate) {
            state.dump = "&ref_" + duplicateIndex + state.dump;
          }
        } else {
          writeFlowSequence(state, level, state.dump);
          if (duplicate) {
            state.dump = "&ref_" + duplicateIndex + " " + state.dump;
          }
        }
      } else if (type2 === "[object String]") {
        if (state.tag !== "?") {
          writeScalar(state, state.dump, level, iskey, inblock);
        }
      } else if (type2 === "[object Undefined]") {
        return false;
      } else {
        if (state.skipInvalid) return false;
        throw new exception("unacceptable kind of an object to dump " + type2);
      }
      if (state.tag !== null && state.tag !== "?") {
        tagStr = encodeURI(
          state.tag[0] === "!" ? state.tag.slice(1) : state.tag
        ).replace(/!/g, "%21");
        if (state.tag[0] === "!") {
          tagStr = "!" + tagStr;
        } else if (tagStr.slice(0, 18) === "tag:yaml.org,2002:") {
          tagStr = "!!" + tagStr.slice(18);
        } else {
          tagStr = "!<" + tagStr + ">";
        }
        state.dump = tagStr + " " + state.dump;
      }
    }
    return true;
  }
  function getDuplicateReferences(object, state) {
    var objects = [], duplicatesIndexes = [], index, length;
    inspectNode(object, objects, duplicatesIndexes);
    for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
      state.duplicates.push(objects[duplicatesIndexes[index]]);
    }
    state.usedDuplicates = new Array(length);
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
    var state = new State(options);
    if (!state.noRefs) getDuplicateReferences(input, state);
    var value = input;
    if (state.replacer) {
      value = state.replacer.call({ "": value }, "", value);
    }
    if (writeNode(state, 0, value, true, true)) return state.dump + "\n";
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
  var WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
  var BLOCK_REFERENCE_WIKILINK_RE = /^[a-zA-Z_][\w\-./:]*$/;
  function extractWikilinks(src) {
    const out = [];
    for (const match of stripInlineCodeSpans(src).matchAll(WIKILINK_RE)) {
      const parsed = parseWikilink(match[1] ?? "");
      if (parsed) out.push(parsed);
    }
    return out;
  }
  function stripInlineCodeSpans(src) {
    return src.replace(/`[^`\n]*`/g, "");
  }
  function isBlockReferenceWikilinkTarget(target) {
    return BLOCK_REFERENCE_WIKILINK_RE.test(target);
  }
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
    text = text.replace(WIKILINK_RE, (match, raw) => renderWikilinkHtml(match, raw));
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
    text = unescapeMarkdownTextEscapes(text).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/\b_([^_]+)_\b/g, "$1").replace(MARKDOWN_LINK_RE, (_m, label, href) => `${unescapeMarkdownLinkLabel(label)} (${href})`).replace(WIKILINK_RE, (match, raw) => parseWikilink(raw)?.label ?? match);
    const restoreRe = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g");
    return text.replace(restoreRe, (_m, i) => codeSpans[Number(i)] ?? "");
  }
  function renderWikilinkHtml(match, raw) {
    const parsed = parseWikilink(raw);
    if (!parsed) return match;
    const hrefTarget = isBlockReferenceWikilinkTarget(parsed.target) ? parsed.target : encodeURIComponent(parsed.target);
    return `<a class="noma-ref" href="#${escapeAttr(hrefTarget)}">${parsed.label}</a>`;
  }
  function parseWikilink(raw) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes("[") || trimmed.includes("]")) return void 0;
    const pipe = trimmed.indexOf("|");
    const target = (pipe === -1 ? trimmed : trimmed.slice(0, pipe)).trim();
    const label = (pipe === -1 ? defaultWikilinkLabel(target) : trimmed.slice(pipe + 1).trim()) || defaultWikilinkLabel(target);
    if (!target) return void 0;
    return { raw: trimmed, target, label };
  }
  function defaultWikilinkLabel(target) {
    return target.replace(/^#/, "").replace(/#/g, " > ");
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
  function escapePipeTableCell(cell) {
    let out = "";
    let inBacktick = false;
    for (let i = 0; i < cell.length; i++) {
      const ch = cell[i];
      if (ch === "`") {
        inBacktick = !inBacktick;
        out += ch;
        continue;
      }
      if (ch === "|" && !inBacktick && cell[i - 1] !== "\\") {
        out += "\\|";
        continue;
      }
      out += ch;
    }
    return out;
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
  function serializeDelimitedRow(cells, delimiter) {
    return cells.map((cell) => serializeDelimitedCell(cell, delimiter)).join(delimiter);
  }
  function serializeDelimitedCell(cell, delimiter) {
    if (!cell.includes(delimiter) && !cell.includes('"') && !/^\s|\s$/.test(cell)) return cell;
    return `"${cell.replace(/"/g, '""')}"`;
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
  var MAX_FENCE_COLONS = 64;
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
      const slug2 = slugify(stem);
      if (slug2 && slug2 !== root.id) aliases.add(slug2);
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
        if (colons > MAX_FENCE_COLONS) {
          out.push(paragraph(line, i));
          i++;
          continue;
        }
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
          const slug2 = section.id;
          if (seenSlugSections.has(slug2)) {
            let n = 2;
            while (seenSlugSections.has(`${slug2}-${n}`)) n++;
            section.id = `${slug2}-${n}`;
            seenSlugSections.add(section.id);
          } else {
            seenSlugSections.add(slug2);
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

  // src/hash.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var rotr = (x, n) => x >>> n | x << 32 - n;
  function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input);
    const bitLen = bytes.length * 8;
    const paddedLen = (bytes.length + 8 >> 6) + 1 << 6;
    const data = new Uint8Array(paddedLen);
    data.set(bytes);
    data[bytes.length] = 128;
    const view = new DataView(data.buffer);
    view.setUint32(paddedLen - 8, Math.floor(bitLen / 4294967296));
    view.setUint32(paddedLen - 4, bitLen >>> 0);
    const h = new Uint32Array([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLen; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ w15 >>> 3;
        const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ w2 >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = e & f ^ ~e & g;
        const t1 = hh + s1 + ch + K[i] + w[i] >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = s0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h[0] = h[0] + a >>> 0;
      h[1] = h[1] + b >>> 0;
      h[2] = h[2] + c >>> 0;
      h[3] = h[3] + d >>> 0;
      h[4] = h[4] + e >>> 0;
      h[5] = h[5] + f >>> 0;
      h[6] = h[6] + g >>> 0;
      h[7] = h[7] + hh >>> 0;
    }
    let out = "";
    for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
    return out;
  }

  // src/patch.ts
  var PatchError = class extends Error {
    constructor(code, message, op) {
      super(message);
      this.code = code;
      this.op = op;
      this.name = "PatchError";
    }
    code;
    op;
  };
  function findById(node, id) {
    if (node.id === id) return node;
    for (const arr of childArrays(node)) {
      for (const child of arr.list) {
        const found = findById(child, id);
        if (found) return found;
      }
    }
    return null;
  }
  function containsId(node, id) {
    return findById(node, id) !== null;
  }
  function childArrays(node) {
    if (node.type === "document" || node.type === "section" || node.type === "directive") {
      return [{ key: "children", list: node.children }];
    }
    if (node.type === "list") {
      return [{ key: "items", list: node.items }];
    }
    return [];
  }
  function hasChildren(node) {
    return node.type === "document" || node.type === "section" || node.type === "directive";
  }
  function isBodyOnlyDirective(node) {
    return isDirective(node) && (node.children.length === 0 || node.children.length === 1 && node.children[0]?.type === "paragraph" && node.body !== void 0);
  }
  function commentAttrs(op) {
    return {
      id: op.id,
      ...op.reply_to ? { reply_to: op.reply_to } : { parent: op.target },
      ...op.author ? { author: op.author } : {},
      ...op.initials ? { initials: op.initials } : {},
      ...op.date ? { date: op.date } : {}
    };
  }
  function isCommentDirective(node) {
    return isDirective(node) && node.name === "comment";
  }
  function noteAttrs(op) {
    return {
      id: op.id,
      for: op.target,
      ...op.label ? { label: op.label } : {}
    };
  }
  function changeRequestAttrs(op) {
    return {
      id: op.id,
      target: op.target,
      action: op.action,
      ...op.from !== void 0 ? { from: op.from } : {},
      ...op.to !== void 0 ? { to: op.to } : {},
      ...op.text !== void 0 ? { text: op.text } : {},
      ...op.author ? { author: op.author } : {},
      ...op.date ? { date: op.date } : {}
    };
  }
  function isTableDirective(node) {
    return isDirective(node) && node.name === "table";
  }
  function isDatasetDirective(node) {
    return isDirective(node) && node.name === "dataset";
  }
  function sourceTableDirectiveRows(sourceLines, start, end, node, op) {
    const lines = [];
    for (let i = start; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      if (!line.trim()) continue;
      lines.push({
        index: i,
        indent: line.match(/^\s*/)?.[0] ?? "",
        cells: tableLineCells(line.trim(), op)
      });
    }
    return tableRowsFromCells(lines, node, op);
  }
  function tableRowsFromCells(parsed, node, op) {
    if (parsed.length === 0) {
      throw new PatchError("invalid_content", `table "${node.id ?? "?"}" has no rows`, op);
    }
    const wantsHeader = node.attrs.header === true || node.attrs.header === "true";
    const lines = parsed.map((entry, index) => {
      if (Array.isArray(entry)) return { index, indent: "", cells: entry };
      return entry;
    });
    const header = wantsHeader ? lines[0]?.cells : void 0;
    const rows = wantsHeader ? lines.slice(1).map((line) => line.cells) : lines.map((line) => line.cells);
    return {
      ...header ? { header } : {},
      rows,
      lines
    };
  }
  function updateTableRows(table, op) {
    if (!Number.isInteger(op.row) || op.row < 0) {
      throw new PatchError("invalid_content", `table row must be a non-negative integer`, op);
    }
    if (op.value.includes("\n") || op.value.includes("\r")) {
      throw new PatchError("invalid_content", `table cell value must be a single line`, op);
    }
    if (op.row >= table.rows.length) {
      throw new PatchError("invalid_content", `table row ${op.row} is out of range`, op);
    }
    const column = tableColumnIndex(table, op);
    const columnCount = tableColumnCount(table);
    if (column >= columnCount) {
      throw new PatchError("invalid_content", `table column ${String(op.column)} is out of range`, op);
    }
    for (const row2 of table.rows) {
      while (row2.length < columnCount) row2.push("");
    }
    const row = table.rows[op.row];
    row[column] = op.value;
    const lineOffset = table.header ? op.row + 1 : op.row;
    return { lineOffset, cells: row };
  }
  function updateTableHeaderCell(table, op) {
    if (!table.header) {
      throw new PatchError("invalid_content", `table header cell update requires header=true`, op);
    }
    if (op.value.includes("\n") || op.value.includes("\r")) {
      throw new PatchError("invalid_content", `table header cell value must be a single line`, op);
    }
    const column = tableColumnIndex(table, op);
    const columnCount = tableColumnCount(table);
    if (column >= columnCount) {
      throw new PatchError("invalid_content", `table column ${String(op.column)} is out of range`, op);
    }
    while (table.header.length < columnCount) table.header.push("");
    table.header[column] = op.value;
    return { lineOffset: 0, cells: table.header };
  }
  function insertTableRow(table, op) {
    const row = validateTableRowIndex(op.row, table.rows.length, true, op);
    const cells = normalizeInsertedTableCells(table, op);
    table.rows.splice(row, 0, cells);
    const lineOffset = table.header ? row + 1 : row;
    return { lineOffset, cells };
  }
  function deleteTableRow(table, op) {
    const row = validateTableRowIndex(op.row, table.rows.length, false, op);
    table.rows.splice(row, 1);
    return { lineOffset: table.header ? row + 1 : row };
  }
  function insertTableColumn(table, op) {
    const columnCount = tableColumnCount(table);
    const column = validateTableColumnInsertIndex(op.column, columnCount, op);
    const cells = normalizeInsertedTableColumnCells(table, op);
    normalizeTableRows(table, columnCount);
    if (table.header) table.header.splice(column, 0, op.header ?? "");
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
      table.rows[rowIndex].splice(column, 0, cells[rowIndex] ?? "");
    }
  }
  function deleteTableColumn(table, op) {
    const columnCount = tableColumnCount(table);
    if (columnCount <= 1) {
      throw new PatchError("invalid_content", `cannot delete the last table column`, op);
    }
    const column = tableColumnIndex(table, op);
    if (column >= columnCount) {
      throw new PatchError("invalid_content", `table column ${String(op.column)} is out of range`, op);
    }
    normalizeTableRows(table, columnCount);
    if (table.header) table.header.splice(column, 1);
    for (const row of table.rows) row.splice(column, 1);
  }
  function validateTableRowIndex(row, length, allowEnd, op) {
    if (!Number.isInteger(row) || row < 0) {
      throw new PatchError("invalid_content", `table row must be a non-negative integer`, op);
    }
    const max = allowEnd ? length : length - 1;
    if (row > max) {
      throw new PatchError("invalid_content", `table row ${row} is out of range`, op);
    }
    return row;
  }
  function normalizeInsertedTableCells(table, op) {
    if (!Array.isArray(op.cells)) {
      throw new PatchError("invalid_content", `table row cells must be an array`, op);
    }
    const cells = op.cells.map((cell) => String(cell));
    for (const cell of cells) {
      if (cell.includes("\n") || cell.includes("\r")) {
        throw new PatchError("invalid_content", `table row cells must be single-line strings`, op);
      }
    }
    const columnCount = tableColumnCount(table);
    while (cells.length < columnCount) cells.push("");
    return cells;
  }
  function validateTableColumnInsertIndex(column, length, op) {
    if (!Number.isInteger(column) || column < 0) {
      throw new PatchError("invalid_content", `table column must be a non-negative integer`, op);
    }
    if (column > length) {
      throw new PatchError("invalid_content", `table column ${column} is out of range`, op);
    }
    return column;
  }
  function normalizeInsertedTableColumnCells(table, op) {
    if (!Array.isArray(op.cells)) {
      throw new PatchError("invalid_content", `table column cells must be an array`, op);
    }
    if (!table.header && op.header !== void 0) {
      throw new PatchError("invalid_content", `table column header requires header=true`, op);
    }
    if (op.header !== void 0 && (op.header.includes("\n") || op.header.includes("\r"))) {
      throw new PatchError("invalid_content", `table column header must be a single-line string`, op);
    }
    if (op.cells.length > table.rows.length) {
      throw new PatchError("invalid_content", `table column cells exceed row count`, op);
    }
    const cells = op.cells.map((cell) => String(cell));
    for (const cell of cells) {
      if (cell.includes("\n") || cell.includes("\r")) {
        throw new PatchError("invalid_content", `table column cells must be single-line strings`, op);
      }
    }
    while (cells.length < table.rows.length) cells.push("");
    return cells;
  }
  function normalizeTableRows(table, columnCount) {
    if (table.header) {
      while (table.header.length < columnCount) table.header.push("");
    }
    for (const row of table.rows) {
      while (row.length < columnCount) row.push("");
    }
  }
  function validateChangeRequestOp(op) {
    const attrValues = [op.from, op.to, op.text, op.author, op.date];
    for (const value of attrValues) {
      if (value !== void 0 && (value.includes("\n") || value.includes("\r"))) {
        throw new PatchError("invalid_content", `change_request attributes must be single-line strings`, op);
      }
    }
    if (op.action === "replace") {
      if (!op.from || !op.to) {
        throw new PatchError("invalid_content", `replace change_request requires from and to`, op);
      }
      return;
    }
    if (op.action === "insert") {
      if (!op.to && !op.text) {
        throw new PatchError("invalid_content", `insert change_request requires to or text`, op);
      }
      return;
    }
    if (op.action === "delete") {
      if (!op.from && !op.text) {
        throw new PatchError("invalid_content", `delete change_request requires from or text`, op);
      }
      return;
    }
    throw new PatchError("invalid_content", `change_request action must be insert, delete, or replace`, op);
  }
  function validateNoteOp(op) {
    if (!op.content.trim()) {
      throw new PatchError("invalid_content", `${op.op === "add_footnote" ? "footnote" : "endnote"} content must not be empty`, op);
    }
    if (op.label !== void 0 && (op.label.includes("\n") || op.label.includes("\r"))) {
      throw new PatchError("invalid_content", `note label must be a single-line string`, op);
    }
  }
  function tableColumnIndex(table, op) {
    if (typeof op.column === "number") {
      if (!Number.isInteger(op.column) || op.column < 0) {
        throw new PatchError("invalid_content", `table column must be a non-negative integer`, op);
      }
      return op.column;
    }
    if (!table.header) {
      throw new PatchError("invalid_content", `table column labels require header=true`, op);
    }
    const index = table.header.indexOf(op.column);
    if (index === -1) {
      throw new PatchError("invalid_content", `table column "${op.column}" not found`, op);
    }
    return index;
  }
  function tableColumnCount(table) {
    return Math.max(
      table.header?.length ?? 0,
      ...table.rows.map((row) => row.length)
    );
  }
  function tableLineCells(line, op) {
    if (!line.includes("|")) {
      throw new PatchError("invalid_content", `table rows must use pipe syntax`, op);
    }
    return splitPipeRow(line);
  }
  function datasetFormat(node) {
    const format = node.attrs.format;
    return typeof format === "string" && format.trim() ? format.trim().toLowerCase() : "yaml";
  }
  function parseJsonDatasetText(body, node, op) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" is not valid JSON`, op);
    }
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && firstJsonRowIsRecord(parsed)) {
        const columns2 = Object.keys(parsed[0]);
        return {
          columns: columns2,
          rows: parsed.map((row) => columns2.map((column) => row[column] ?? null)),
          sourceShape: "records"
        };
      }
      return {
        columns: columnsAttr(node),
        rows: parsed.filter(Array.isArray).map((row) => [...row]),
        sourceShape: "arrays"
      };
    }
    const record = recordValue(parsed);
    if (!record || !Array.isArray(record.rows)) {
      throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" has no JSON rows array`, op);
    }
    const columns = Array.isArray(record.columns) ? record.columns.map(String) : columnsAttr(node);
    return {
      columns,
      rows: record.rows.filter(Array.isArray).map((row) => [...row]),
      sourceShape: "object"
    };
  }
  function loadYamlDatasetText(body, id, op) {
    let parsed;
    try {
      parsed = jsYaml.load(body);
    } catch {
      throw new PatchError("invalid_content", `dataset "${id ?? "?"}" is not valid YAML`, op);
    }
    const record = recordValue(parsed);
    if (!record) throw new PatchError("invalid_content", `dataset "${id ?? "?"}" must be a YAML object`, op);
    return record;
  }
  function datasetColumnsFromYaml(node, parsed, rows) {
    const schema2 = recordValue(parsed.schema);
    if (schema2) return Object.keys(schema2);
    const attrColumns = columnsAttr(node);
    if (attrColumns.length > 0) return attrColumns;
    return inferredDatasetColumns(rows);
  }
  function columnsAttr(node) {
    const columns = node.attrs.columns;
    return typeof columns === "string" ? columns.split(/[,\s]+/).filter(Boolean) : [];
  }
  function inferredDatasetColumns(rows) {
    const width = Math.max(0, ...rows.filter(Array.isArray).map((row) => row.length));
    return Array.from({ length: width }, (_value, index) => `Column ${index + 1}`);
  }
  function updateDatasetRows(table, op) {
    if (!Number.isInteger(op.row) || op.row < 0) {
      throw new PatchError("invalid_content", `dataset row must be a non-negative integer`, op);
    }
    if (op.value.includes("\n") || op.value.includes("\r")) {
      throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
    }
    if (op.row >= table.rows.length) {
      throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
    }
    const column = datasetColumnIndex(table, op);
    const columnCount = datasetColumnCount(table);
    if (column >= columnCount) {
      throw new PatchError("invalid_content", `dataset column ${String(op.column)} is out of range`, op);
    }
    for (const row2 of table.rows) {
      while (row2.length < columnCount) row2.push(null);
    }
    const row = table.rows[op.row];
    const columnName = table.columns[column];
    row[column] = coerceDatasetPatchValue(op.value, columnName ? table.schema?.[columnName] : void 0);
    return { lineOffset: op.row, column, cells: row };
  }
  function insertDatasetRow(table, op) {
    const row = validateDatasetRowIndex(op.row, table.rows.length, true, op);
    const cells = normalizeInsertedDatasetCells(table, op);
    table.rows.splice(row, 0, cells);
    return { lineOffset: row, cells };
  }
  function deleteDatasetRow(table, op) {
    const row = validateDatasetRowIndex(op.row, table.rows.length, false, op);
    table.rows.splice(row, 1);
    return { lineOffset: row };
  }
  function insertDatasetColumn(table, op) {
    const column = validateDatasetColumnInsertIndex(op.column, datasetColumnCount(table), op);
    if (op.header.includes("\n") || op.header.includes("\r") || op.header.trim().length === 0) {
      throw new PatchError("invalid_content", `dataset column header must be a non-empty single-line string`, op);
    }
    if (table.columns.includes(op.header)) {
      throw new PatchError("invalid_content", `dataset column "${op.header}" already exists`, op);
    }
    const values = normalizeInsertedDatasetColumnCells(table, op);
    const schemaValue = inferDatasetType(values.map(datasetScalarText));
    normalizeDatasetRows(table, datasetColumnCount(table));
    table.columns.splice(column, 0, op.header);
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
      table.rows[rowIndex].splice(column, 0, values[rowIndex] ?? "");
    }
    if (table.schema) {
      table.schema = insertRecordEntry(table.schema, op.header, schemaValue, column);
    }
    return { column, values };
  }
  function deleteDatasetColumn(table, op) {
    const columnCount = datasetColumnCount(table);
    if (columnCount <= 1) {
      throw new PatchError("invalid_content", `cannot delete the last dataset column`, op);
    }
    const column = datasetColumnIndex(table, op);
    if (column >= columnCount) {
      throw new PatchError("invalid_content", `dataset column ${String(op.column)} is out of range`, op);
    }
    normalizeDatasetRows(table, columnCount);
    const header = table.columns[column] ?? `Column ${column + 1}`;
    table.columns.splice(column, 1);
    for (const row of table.rows) row.splice(column, 1);
    if (table.schema) {
      const nextSchema = {};
      for (const [key, value] of Object.entries(table.schema)) {
        if (key !== header) nextSchema[key] = value;
      }
      table.schema = nextSchema;
    }
    return { column, header };
  }
  function validateDatasetRowIndex(row, length, allowEnd, op) {
    if (!Number.isInteger(row) || row < 0) {
      throw new PatchError("invalid_content", `dataset row must be a non-negative integer`, op);
    }
    const max = allowEnd ? length : length - 1;
    if (row > max) {
      throw new PatchError("invalid_content", `dataset row ${row} is out of range`, op);
    }
    return row;
  }
  function normalizeInsertedDatasetCells(table, op) {
    if (!Array.isArray(op.cells)) {
      throw new PatchError("invalid_content", `dataset row cells must be an array`, op);
    }
    const rawCells = op.cells.map((cell) => String(cell));
    for (const cell of rawCells) {
      if (cell.includes("\n") || cell.includes("\r")) {
        throw new PatchError("invalid_content", `dataset row cells must be single-line strings`, op);
      }
    }
    let columnCount = datasetColumnCount(table);
    if (columnCount === 0) {
      columnCount = rawCells.length;
      table.columns = inferredDatasetColumns([rawCells]);
    }
    if (rawCells.length > columnCount) {
      throw new PatchError("invalid_content", `dataset row cells exceed column count`, op);
    }
    while (rawCells.length < columnCount) rawCells.push("");
    return rawCells.map((cell, column) => {
      const columnName = table.columns[column];
      return coerceDatasetPatchValue(cell, columnName ? table.schema?.[columnName] : void 0);
    });
  }
  function validateDatasetColumnInsertIndex(column, length, op) {
    if (!Number.isInteger(column) || column < 0) {
      throw new PatchError("invalid_content", `dataset column must be a non-negative integer`, op);
    }
    if (column > length) {
      throw new PatchError("invalid_content", `dataset column ${column} is out of range`, op);
    }
    return column;
  }
  function normalizeInsertedDatasetColumnCells(table, op) {
    if (!Array.isArray(op.cells)) {
      throw new PatchError("invalid_content", `dataset column cells must be an array`, op);
    }
    if (op.cells.length > table.rows.length) {
      throw new PatchError("invalid_content", `dataset column cells exceed row count`, op);
    }
    const cells = op.cells.map((cell) => String(cell));
    for (const cell of cells) {
      if (cell.includes("\n") || cell.includes("\r")) {
        throw new PatchError("invalid_content", `dataset column cells must be single-line strings`, op);
      }
    }
    while (cells.length < table.rows.length) cells.push("");
    const schemaValue = inferDatasetType(cells);
    return cells.map((cell) => coerceDatasetPatchValue(cell, schemaValue));
  }
  function normalizeDatasetRows(table, columnCount) {
    while (table.columns.length < columnCount) table.columns.push(`Column ${table.columns.length + 1}`);
    for (const row of table.rows) {
      while (row.length < columnCount) row.push(null);
    }
  }
  function insertRecordEntry(record, key, value, index) {
    const out = {};
    const entries = Object.entries(record);
    for (let i = 0; i <= entries.length; i++) {
      if (i === index) out[key] = value;
      const entry = entries[i];
      if (entry) out[entry[0]] = entry[1];
    }
    return out;
  }
  function datasetColumnIndex(table, op) {
    if (typeof op.column === "number") {
      if (!Number.isInteger(op.column) || op.column < 0) {
        throw new PatchError("invalid_content", `dataset column must be a non-negative integer`, op);
      }
      return op.column;
    }
    const index = table.columns.indexOf(op.column);
    if (index === -1) throw new PatchError("invalid_content", `dataset column "${op.column}" not found`, op);
    return index;
  }
  function datasetColumnCount(table) {
    return Math.max(table.columns.length, ...table.rows.map((row) => row.length), 0);
  }
  function coerceDatasetPatchValue(value, schemaValue) {
    const type2 = schemaType(schemaValue);
    if (type2 === "number" || type2 === "integer") {
      if (!value.trim()) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : value;
    }
    if (type2 === "boolean") {
      if (!value.trim()) return null;
      return booleanText(value) ?? value;
    }
    return type2 ? value : coerceDatasetScalar(value);
  }
  function coerceDatasetScalar(value) {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const boolean = booleanText(trimmed);
    if (boolean !== void 0) return boolean;
    const number = Number(trimmed);
    if (Number.isFinite(number) && /^-?\d/.test(trimmed)) return number;
    return value;
  }
  function inferDatasetType(values) {
    const present = values.map((value) => value.trim()).filter(Boolean);
    if (present.length === 0) return "string";
    if (present.every((value) => Number.isFinite(Number(value)))) return "number";
    if (present.every((value) => booleanText(value) !== void 0)) return "boolean";
    return "string";
  }
  function schemaType(schemaValue) {
    if (typeof schemaValue === "string") return schemaValue.toLowerCase();
    const record = recordValue(schemaValue);
    const type2 = record?.type;
    return typeof type2 === "string" ? type2.toLowerCase() : void 0;
  }
  function booleanText(value) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
    if (normalized === "false" || normalized === "no" || normalized === "0") return false;
    return void 0;
  }
  function datasetScalarText(value) {
    if (value === null || value === void 0) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }
  function firstJsonRowIsRecord(rows) {
    const first = rows[0];
    return Boolean(first && typeof first === "object" && !Array.isArray(first));
  }
  function recordValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function allTableRows(table) {
    return table.header ? [table.header, ...table.rows] : table.rows;
  }
  function serializePipeRow(cells, indent = "") {
    return `${indent}| ${cells.map(escapePipeTableCell).join(" | ")} |`;
  }
  function parseFragment(content, op) {
    const doc = parse(content);
    if (doc.children.length === 0) {
      throw new PatchError("invalid_content", `fragment parsed to no blocks`, op);
    }
    if (doc.children.length > 1) {
      throw new PatchError(
        "invalid_content",
        `fragment must contain exactly one top-level block (got ${doc.children.length})`,
        op
      );
    }
    const node = doc.children[0];
    if (!isDirective(node)) {
      throw new PatchError("invalid_content", `fragment must be a directive block (got ${node.type})`, op);
    }
    return node;
  }
  function patchSource(source, ops) {
    const list = Array.isArray(ops) ? ops : [ops];
    let cur = source;
    for (const op of list) cur = applyToSource(cur, op);
    return cur;
  }
  function blockSourceHash(source, id) {
    const doc = parse(source);
    const node = findById(doc, id);
    if (!node) throw new Error(`block "${id}" not found`);
    const start = node.pos?.line;
    const end = node.endLine;
    if (!start || !end) throw new Error(`block "${id}" has no source span`);
    return sha256Hex(source.split("\n").slice(start - 1, end).join("\n"));
  }
  function patchTargetId(op) {
    switch (op.op) {
      case "rename_id":
        return op.from;
      case "add_block":
        return op.parent;
      case "add_comment":
      case "add_footnote":
      case "add_endnote":
      case "add_change_request":
        return op.target;
      default:
        return op.id;
    }
  }
  function verifyBaseHash(source, op) {
    const expected = op.baseHash?.trim().toLowerCase();
    if (!expected) return;
    if (!/^[0-9a-f]{8,64}$/.test(expected)) {
      throw new PatchError(
        "invalid_content",
        `baseHash must be 8\u201364 hex chars of the block's sha256 (got "${op.baseHash}")`,
        op
      );
    }
    const targetId = patchTargetId(op);
    let actual;
    try {
      actual = blockSourceHash(source, targetId);
    } catch {
      throw new PatchError("target_missing", `block "${targetId}" not found`, op);
    }
    if (!actual.startsWith(expected)) {
      throw new PatchError(
        "sha_mismatch",
        `block "${targetId}" changed since it was read: baseHash ${expected.slice(0, 12)} does not match current ${actual.slice(0, 12)}`,
        op
      );
    }
  }
  function applyToSource(source, op) {
    verifyBaseHash(source, op);
    switch (op.op) {
      case "update_attribute":
        return applySrcUpdateAttr(source, op);
      case "remove_attribute":
        return applySrcRemoveAttr(source, op);
      case "replace_block":
        return applySrcReplace(source, op);
      case "replace_body":
        return applySrcReplaceBody(source, op);
      case "update_heading":
        return applySrcUpdateHeading(source, op);
      case "add_comment":
        return applySrcAddComment(source, op);
      case "resolve_comment":
        return applySrcResolveComment(source, op);
      case "add_footnote":
      case "add_endnote":
        return applySrcAddNote(source, op);
      case "add_change_request":
        return applySrcAddChangeRequest(source, op);
      case "update_table_cell":
        return applySrcUpdateTableCell(source, op);
      case "update_table_header_cell":
        return applySrcUpdateTableHeaderCell(source, op);
      case "insert_table_row":
        return applySrcInsertTableRow(source, op);
      case "delete_table_row":
        return applySrcDeleteTableRow(source, op);
      case "insert_table_column":
        return applySrcInsertTableColumn(source, op);
      case "delete_table_column":
        return applySrcDeleteTableColumn(source, op);
      case "update_dataset_cell":
        return applySrcUpdateDatasetCell(source, op);
      case "insert_dataset_row":
        return applySrcInsertDatasetRow(source, op);
      case "delete_dataset_row":
        return applySrcDeleteDatasetRow(source, op);
      case "insert_dataset_column":
        return applySrcInsertDatasetColumn(source, op);
      case "delete_dataset_column":
        return applySrcDeleteDatasetColumn(source, op);
      case "move_block":
        return applySrcMove(source, op);
      case "delete_block":
        return applySrcDelete(source, op);
      case "add_block":
        return applySrcAdd(source, op);
      case "rename_id":
        return applySrcRenameId(source, op);
      default: {
        const _exhaustive = op;
        void _exhaustive;
        throw new Error("unknown patch op");
      }
    }
  }
  function locate(source, id, op) {
    const doc = parse(source);
    const node = findById(doc, id);
    if (!node) throw new PatchError("target_missing", `block "${id}" not found`, op);
    const start = node.pos?.line;
    const end = node.endLine;
    if (!start || !end) {
      throw new Error(`block "${id}" has no source span`);
    }
    return { node, start, end };
  }
  function applySrcReplaceBody(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    const lines = source.split("\n");
    const bodyLines = op.content.replace(/\n+$/, "").split("\n");
    if (isDirective(node)) {
      if (!isBodyOnlyDirective(node)) {
        throw new PatchError("invalid_content", `block "${op.id}" has child blocks; use replace_block`, op);
      }
      lines.splice(start, Math.max(0, end - start - 1), ...bodyLines);
      return lines.join("\n");
    }
    if (node.type === "paragraph") {
      lines.splice(start - 1, end - start + 1, ...bodyLines);
      return lines.join("\n");
    }
    if (node.type === "quote") {
      const quoted = bodyLines.map((line) => line ? `> ${line}` : ">");
      lines.splice(start - 1, end - start + 1, ...quoted);
      return lines.join("\n");
    }
    if (node.type === "code") {
      lines.splice(start, Math.max(0, end - start - 1), ...bodyLines);
      return lines.join("\n");
    }
    if (node.type === "list_item") {
      const marker = (lines[start - 1] ?? "").match(/^(\s*(?:[-*+]|\d+[.)])\s+)/)?.[1] ?? "- ";
      lines[start - 1] = `${marker}${op.content.replace(/\n/g, " ")}`;
      return lines.join("\n");
    }
    throw new PatchError("invalid_content", `block "${op.id}" does not have replaceable body text`, op);
  }
  function applySrcUpdateHeading(source, op) {
    const { node, start } = locate(source, op.id, op);
    if (node.type !== "section") {
      throw new PatchError("invalid_content", `block "${op.id}" is not a section heading`, op);
    }
    const lines = source.split("\n");
    lines[start - 1] = rewriteHeadingTitle(lines[start - 1] ?? "", op.title, node.id);
    return lines.join("\n");
  }
  function applySrcUpdateAttr(source, op) {
    if (op.key === "id") {
      throw new PatchError("id_attribute_protected", `use rename_id to change a block's id`, op);
    }
    const { node, start } = locate(source, op.id, op);
    if (!isDirective(node)) {
      throw new PatchError("target_missing", `block "${op.id}" is not a directive`, op);
    }
    const lines = source.split("\n");
    const lineIdx = start - 1;
    const open = lines[lineIdx] ?? "";
    lines[lineIdx] = rewriteOpenLineAttr(open, op.key, op.value, op);
    return lines.join("\n");
  }
  function applySrcRemoveAttr(source, op) {
    if (op.key === "id") {
      throw new PatchError("id_attribute_protected", `use rename_id to change a block's id`, op);
    }
    const { node, start } = locate(source, op.id, op);
    if (!isDirective(node)) {
      throw new PatchError("target_missing", `block "${op.id}" is not a directive`, op);
    }
    const lines = source.split("\n");
    const lineIdx = start - 1;
    const open = lines[lineIdx] ?? "";
    lines[lineIdx] = rewriteOpenLineRemoveAttr(open, op.key, op);
    return lines.join("\n");
  }
  function applySrcReplace(source, op) {
    parseFragment(op.content, op);
    const { start, end } = locate(source, op.id, op);
    const lines = source.split("\n");
    const replacement = op.content.replace(/\n+$/, "").split("\n");
    lines.splice(start - 1, end - start + 1, ...replacement);
    return lines.join("\n");
  }
  function applySrcDelete(source, op) {
    const { start, end } = locate(source, op.id, op);
    const lines = source.split("\n");
    let removeCount = end - start + 1;
    if (lines[start - 1 + removeCount] === "" && lines[start - 2] === "") {
      removeCount += 1;
    }
    lines.splice(start - 1, removeCount);
    return lines.join("\n");
  }
  function applySrcAdd(source, op) {
    parseFragment(op.content, op);
    const doc = parse(source);
    const parent = findById(doc, op.parent);
    if (!parent) throw new PatchError("parent_missing", `parent "${op.parent}" not found`, op);
    if (!hasChildren(parent)) {
      throw new PatchError("parent_missing", `parent "${op.parent}" cannot have children`, op);
    }
    const children = parent.children;
    const pos = Math.max(0, Math.min(op.position ?? children.length, children.length));
    const lines = source.split("\n");
    const fragmentLines = op.content.replace(/\n+$/, "").split("\n");
    let insertAt;
    if (pos < children.length) {
      const next = children[pos];
      const nextStart = next.pos?.line;
      if (!nextStart) throw new Error(`sibling has no source span`);
      insertAt = nextStart - 1;
      fragmentLines.push("");
    } else if (children.length > 0) {
      const last = children[children.length - 1];
      const lastEnd = last.endLine;
      if (!lastEnd) throw new Error(`sibling has no source span`);
      insertAt = lastEnd;
      fragmentLines.unshift("");
    } else {
      if (parent.type === "directive" && parent.endLine) {
        insertAt = parent.endLine - 1;
      } else if (parent.type === "section" && parent.endLine) {
        insertAt = parent.endLine;
      } else {
        insertAt = lines.length;
      }
    }
    lines.splice(insertAt, 0, ...fragmentLines);
    return lines.join("\n");
  }
  function applySrcAddComment(source, op) {
    const doc = parse(source);
    if (findById(doc, op.id)) {
      throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
    }
    const target = findById(doc, op.target);
    if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
    const start = target.pos?.line;
    const end = target.endLine;
    if (!start || !end) throw new Error(`block "${op.target}" has no source span`);
    const lines = source.split("\n");
    const fragmentLines = siblingDirectiveFragmentLines(target, lines, serializeCommentBlock(op));
    let insertAt;
    if (target.type === "section") {
      insertAt = start;
      if (lines[insertAt] === "") insertAt += 1;
      fragmentLines.push("");
    } else {
      insertAt = end;
      fragmentLines.unshift("");
    }
    lines.splice(insertAt, 0, ...fragmentLines);
    return lines.join("\n");
  }
  function applySrcResolveComment(source, op) {
    const { node, start } = locate(source, op.id, op);
    if (!isCommentDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a comment`, op);
    }
    const lines = source.split("\n");
    const lineIdx = start - 1;
    lines[lineIdx] = rewriteCommentResolutionAttrs(lines[lineIdx] ?? "", op);
    return lines.join("\n");
  }
  function applySrcAddNote(source, op) {
    validateNoteOp(op);
    const doc = parse(source);
    if (findById(doc, op.id)) {
      throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
    }
    const target = findById(doc, op.target);
    if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
    const start = target.pos?.line;
    const end = target.endLine;
    if (!start || !end) throw new Error(`block "${op.target}" has no source span`);
    const lines = source.split("\n");
    const fragmentLines = siblingDirectiveFragmentLines(target, lines, serializeNoteBlock(op));
    let insertAt;
    if (target.type === "section") {
      insertAt = start;
      if (lines[insertAt] === "") insertAt += 1;
      fragmentLines.push("");
    } else {
      insertAt = end;
      fragmentLines.unshift("");
    }
    lines.splice(insertAt, 0, ...fragmentLines);
    return lines.join("\n");
  }
  function applySrcAddChangeRequest(source, op) {
    validateChangeRequestOp(op);
    const doc = parse(source);
    if (findById(doc, op.id)) {
      throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
    }
    const target = findById(doc, op.target);
    if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
    const start = target.pos?.line;
    const end = target.endLine;
    if (!start || !end) throw new Error(`block "${op.target}" has no source span`);
    const lines = source.split("\n");
    const fragmentLines = siblingDirectiveFragmentLines(target, lines, serializeChangeRequestBlock(op));
    let insertAt;
    if (target.type === "section") {
      insertAt = start;
      if (lines[insertAt] === "") insertAt += 1;
      fragmentLines.push("");
    } else {
      insertAt = end;
      fragmentLines.unshift("");
    }
    lines.splice(insertAt, 0, ...fragmentLines);
    return lines.join("\n");
  }
  function siblingDirectiveFragmentLines(target, lines, source) {
    const targetDepth = isDirective(target) ? directiveFenceDepth(target, lines) : 2;
    return normalizeDirectiveFenceDepth(source, 2, targetDepth).split("\n");
  }
  function applySrcUpdateTableCell(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isTableDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
    }
    const lines = source.split("\n");
    const table = sourceTableDirectiveRows(lines, start, end, node, op);
    const target = updateTableRows(table, op);
    const sourceLine = table.lines[target.lineOffset];
    lines[sourceLine.index] = serializePipeRow(target.cells, sourceLine.indent);
    return lines.join("\n");
  }
  function applySrcUpdateTableHeaderCell(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isTableDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
    }
    const lines = source.split("\n");
    const table = sourceTableDirectiveRows(lines, start, end, node, op);
    const target = updateTableHeaderCell(table, op);
    const sourceLine = table.lines[target.lineOffset];
    lines[sourceLine.index] = serializePipeRow(target.cells, sourceLine.indent);
    return lines.join("\n");
  }
  function applySrcInsertTableRow(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isTableDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
    }
    const lines = source.split("\n");
    const table = sourceTableDirectiveRows(lines, start, end, node, op);
    const target = insertTableRow(table, op);
    const indent = tableRowIndent(table, target.lineOffset);
    const insertAt = tableInsertLineIndex(table, target.lineOffset, end);
    lines.splice(insertAt, 0, serializePipeRow(target.cells, indent));
    return lines.join("\n");
  }
  function applySrcDeleteTableRow(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isTableDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
    }
    const lines = source.split("\n");
    const table = sourceTableDirectiveRows(lines, start, end, node, op);
    const target = deleteTableRow(table, op);
    const sourceLine = table.lines[target.lineOffset];
    if (!sourceLine) throw new PatchError("invalid_content", `table row ${op.row} is out of range`, op);
    lines.splice(sourceLine.index, 1);
    return lines.join("\n");
  }
  function applySrcInsertTableColumn(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isTableDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
    }
    const lines = source.split("\n");
    const table = sourceTableDirectiveRows(lines, start, end, node, op);
    insertTableColumn(table, op);
    rewriteSourceTableRows(lines, table);
    return lines.join("\n");
  }
  function applySrcDeleteTableColumn(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isTableDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
    }
    const lines = source.split("\n");
    const table = sourceTableDirectiveRows(lines, start, end, node, op);
    deleteTableColumn(table, op);
    rewriteSourceTableRows(lines, table);
    return lines.join("\n");
  }
  function applySrcUpdateDatasetCell(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isDatasetDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
    }
    const lines = source.split("\n");
    const format = datasetFormat(node);
    if (format === "csv" || format === "tsv") {
      const delimiter = format === "tsv" ? "	" : ",";
      const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
      const target = updateDatasetRows(table, op);
      const sourceLine = table.lines[target.lineOffset + 1];
      const cells = target.cells.map(datasetScalarText);
      if (cells.some((cell) => /[\r\n]/.test(cell))) {
        throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
      }
      lines[sourceLine.index] = `${sourceLine.indent}${serializeDelimitedRow(cells, delimiter)}`;
      return lines.join("\n");
    }
    if (format === "yaml") {
      const table = sourceYamlDatasetRows(lines, start, end, node, op);
      const target = updateDatasetRows(table, op);
      const sourceLine = table.lines[target.lineOffset];
      lines[sourceLine.index] = `${sourceLine.indent}- ${serializeYamlFlowRow(target.cells)}${sourceLine.trailing}`;
      return lines.join("\n");
    }
    if (format === "json") {
      const table = sourceJsonDatasetRows(lines, start, end, node, op);
      const target = updateDatasetRows(table, op);
      if (table.sourceShape === "records") {
        const sourceRow = table.lines[target.lineOffset];
        if (!sourceRow) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
        const column = target.column;
        const key = table.columns[column];
        if (!key) throw new PatchError("invalid_content", `dataset column ${String(op.column)} is out of range`, op);
        const sourceLine2 = sourceRow.propertyLines.get(key);
        if (sourceLine2 === void 0) {
          throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not map JSON property "${key}"`, op);
        }
        lines[sourceLine2] = rewriteJsonPropertyLine(lines[sourceLine2] ?? "", key, target.cells[column], op);
        return lines.join("\n");
      }
      const sourceLine = table.lines[target.lineOffset];
      if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
      lines[sourceLine.index] = `${sourceLine.indent}${JSON.stringify(target.cells)}${sourceLine.trailing}`;
      return lines.join("\n");
    }
    throw new PatchError("invalid_content", `source-preserving update_dataset_cell does not support ${format} datasets`, op);
  }
  function applySrcInsertDatasetRow(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isDatasetDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
    }
    const lines = source.split("\n");
    const format = datasetFormat(node);
    if (format === "csv" || format === "tsv") {
      const delimiter = format === "tsv" ? "	" : ",";
      const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
      const target = insertDatasetRow(table, op);
      const cells = target.cells.map(datasetScalarText);
      if (cells.some((cell) => /[\r\n]/.test(cell))) {
        throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
      }
      const indent = delimitedDatasetRowIndent(table, target.lineOffset);
      const insertAt = delimitedDatasetInsertLineIndex(table, target.lineOffset, end);
      lines.splice(insertAt, 0, `${indent}${serializeDelimitedRow(cells, delimiter)}`);
      return lines.join("\n");
    }
    if (format === "yaml") {
      const table = sourceYamlDatasetRows(lines, start, end, node, op);
      const target = insertDatasetRow(table, op);
      const indent = yamlDatasetRowIndent(table, target.lineOffset);
      const insertAt = yamlDatasetInsertLineIndex(table, target.lineOffset, end);
      if (table.lines.length === 0) {
        lines[table.rowsLineIndex] = rewriteYamlRowsLineAsBlock(lines[table.rowsLineIndex] ?? "", op);
      }
      lines.splice(insertAt, 0, `${indent}- ${serializeYamlFlowRow(target.cells)}`);
      return lines.join("\n");
    }
    if (format === "json") {
      const table = sourceJsonDatasetRows(lines, start, end, node, op);
      if (table.sourceShape === "records") {
        const target2 = insertDatasetRow(table, op);
        const insertAt2 = jsonRecordDatasetInsertLineIndex(table, target2.lineOffset);
        if (target2.lineOffset >= table.lines.length && table.lines.length > 0) {
          const previous = table.lines[table.lines.length - 1];
          lines[previous.end] = ensureJsonTrailingComma(lines[previous.end] ?? "");
        }
        const reference = jsonRecordReferenceRow(table, target2.lineOffset);
        const trailing2 = target2.lineOffset < table.lines.length ? "," : "";
        lines.splice(insertAt2, 0, ...serializeJsonRecordRow(table.columns, target2.cells, reference, trailing2));
        return lines.join("\n");
      }
      const target = insertDatasetRow(table, op);
      const literal = JSON.stringify(target.cells);
      if (table.inlineEmptyRowsLine) {
        lines.splice(
          table.inlineEmptyRowsLine.index,
          1,
          `${table.inlineEmptyRowsLine.indent}${table.inlineEmptyRowsLine.prefix}[`,
          `${table.rowIndent}${literal}`,
          `${table.inlineEmptyRowsLine.indent}]${table.inlineEmptyRowsLine.trailing}`
        );
        return lines.join("\n");
      }
      const insertAt = jsonDatasetInsertLineIndex(table, target.lineOffset);
      if (target.lineOffset >= table.lines.length && table.lines.length > 0) {
        const previous = table.lines[table.lines.length - 1];
        lines[previous.index] = ensureJsonTrailingComma(lines[previous.index] ?? "");
      }
      const trailing = target.lineOffset < table.lines.length ? "," : "";
      lines.splice(insertAt, 0, `${table.rowIndent}${literal}${trailing}`);
      return lines.join("\n");
    }
    throw new PatchError("invalid_content", `source-preserving insert_dataset_row does not support ${format} datasets`, op);
  }
  function applySrcDeleteDatasetRow(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isDatasetDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
    }
    const lines = source.split("\n");
    const format = datasetFormat(node);
    if (format === "csv" || format === "tsv") {
      const delimiter = format === "tsv" ? "	" : ",";
      const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
      const target = deleteDatasetRow(table, op);
      const sourceLine = table.lines[target.lineOffset + 1];
      if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
      lines.splice(sourceLine.index, 1);
      return lines.join("\n");
    }
    if (format === "yaml") {
      const table = sourceYamlDatasetRows(lines, start, end, node, op);
      const deletingLast = table.rows.length === 1;
      const target = deleteDatasetRow(table, op);
      const sourceLine = table.lines[target.lineOffset];
      if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
      if (deletingLast) {
        lines[table.rowsLineIndex] = rewriteYamlRowsLineAsEmpty(lines[table.rowsLineIndex] ?? "", op);
      }
      lines.splice(sourceLine.index, 1);
      return lines.join("\n");
    }
    if (format === "json") {
      const table = sourceJsonDatasetRows(lines, start, end, node, op);
      if (table.sourceShape === "records") {
        const deletingLast2 = op.row === table.rows.length - 1;
        const target2 = deleteDatasetRow(table, op);
        const sourceRow = table.lines[target2.lineOffset];
        if (!sourceRow) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
        lines.splice(sourceRow.start, sourceRow.end - sourceRow.start + 1);
        if (deletingLast2 && table.lines.length > 1) {
          const previous = table.lines[target2.lineOffset - 1];
          if (previous) lines[previous.end] = removeJsonTrailingComma(lines[previous.end] ?? "");
        }
        return lines.join("\n");
      }
      const deletingLast = op.row === table.rows.length - 1;
      const target = deleteDatasetRow(table, op);
      const sourceLine = table.lines[target.lineOffset];
      if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
      lines.splice(sourceLine.index, 1);
      if (deletingLast && table.lines.length > 1) {
        const previous = table.lines[target.lineOffset - 1];
        if (previous) {
          const previousIndex = previous.index > sourceLine.index ? previous.index - 1 : previous.index;
          lines[previousIndex] = removeJsonTrailingComma(lines[previousIndex] ?? "");
        }
      }
      return lines.join("\n");
    }
    throw new PatchError("invalid_content", `source-preserving delete_dataset_row does not support ${format} datasets`, op);
  }
  function applySrcInsertDatasetColumn(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isDatasetDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
    }
    const lines = source.split("\n");
    const format = datasetFormat(node);
    if (format === "csv" || format === "tsv") {
      const delimiter = format === "tsv" ? "	" : ",";
      const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
      insertDatasetColumn(table, op);
      rewriteSourceDelimitedDatasetRows(lines, table, delimiter, op);
      return lines.join("\n");
    }
    if (format === "yaml") {
      const table = sourceYamlDatasetRows(lines, start, end, node, op);
      const target = insertDatasetColumn(table, op);
      rewriteSourceYamlDatasetRows(lines, table);
      insertSourceYamlSchemaLine(lines, table, target.column, op.header, inferDatasetType(target.values.map(datasetScalarText)), op);
      return lines.join("\n");
    }
    if (format === "json") {
      const table = sourceJsonDatasetRows(lines, start, end, node, op);
      if (table.sourceShape === "records") {
        insertDatasetColumn(table, op);
        rewriteSourceJsonRecordDatasetRows(lines, table);
        return lines.join("\n");
      }
      if (table.sourceShape !== "object") {
        throw new PatchError("invalid_content", `source-preserving insert_dataset_column requires JSON columns in the dataset body`, op);
      }
      insertDatasetColumn(table, op);
      rewriteSourceJsonColumnsLine(lines, table, op);
      rewriteSourceJsonArrayDatasetRows(lines, table);
      return lines.join("\n");
    }
    throw new PatchError("invalid_content", `source-preserving insert_dataset_column does not support ${format} datasets`, op);
  }
  function applySrcDeleteDatasetColumn(source, op) {
    const { node, start, end } = locate(source, op.id, op);
    if (!isDatasetDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
    }
    const lines = source.split("\n");
    const format = datasetFormat(node);
    if (format === "csv" || format === "tsv") {
      const delimiter = format === "tsv" ? "	" : ",";
      const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
      deleteDatasetColumn(table, op);
      rewriteSourceDelimitedDatasetRows(lines, table, delimiter, op);
      return lines.join("\n");
    }
    if (format === "yaml") {
      const table = sourceYamlDatasetRows(lines, start, end, node, op);
      const target = deleteDatasetColumn(table, op);
      rewriteSourceYamlDatasetRows(lines, table);
      deleteSourceYamlSchemaLine(lines, table, target.header, op);
      return lines.join("\n");
    }
    if (format === "json") {
      const table = sourceJsonDatasetRows(lines, start, end, node, op);
      if (table.sourceShape === "records") {
        deleteDatasetColumn(table, op);
        rewriteSourceJsonRecordDatasetRows(lines, table);
        return lines.join("\n");
      }
      if (table.sourceShape !== "object") {
        throw new PatchError("invalid_content", `source-preserving delete_dataset_column requires JSON columns in the dataset body`, op);
      }
      deleteDatasetColumn(table, op);
      rewriteSourceJsonColumnsLine(lines, table, op);
      rewriteSourceJsonArrayDatasetRows(lines, table);
      return lines.join("\n");
    }
    throw new PatchError("invalid_content", `source-preserving delete_dataset_column does not support ${format} datasets`, op);
  }
  function rewriteSourceTableRows(lines, table) {
    const rows = allTableRows(table);
    for (let i = 0; i < table.lines.length; i++) {
      const sourceLine = table.lines[i];
      const row = rows[i];
      if (row) lines[sourceLine.index] = serializePipeRow(row, sourceLine.indent);
    }
  }
  function rewriteSourceDelimitedDatasetRows(lines, table, delimiter, op) {
    const rows = [table.columns, ...table.rows.map((row) => row.map(datasetScalarText))];
    if (rows.some((row) => row.some((cell) => /[\r\n]/.test(cell)))) {
      throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
    }
    for (let i = 0; i < table.lines.length; i++) {
      const sourceLine = table.lines[i];
      const row = rows[i];
      if (row) lines[sourceLine.index] = `${sourceLine.indent}${serializeDelimitedRow(row, delimiter)}`;
    }
  }
  function rewriteSourceYamlDatasetRows(lines, table) {
    for (let i = 0; i < table.lines.length; i++) {
      const sourceLine = table.lines[i];
      const row = table.rows[i];
      if (row) lines[sourceLine.index] = `${sourceLine.indent}- ${serializeYamlFlowRow(row)}${sourceLine.trailing}`;
    }
  }
  function insertSourceYamlSchemaLine(lines, table, column, header, schemaValue, op) {
    if (table.schemaLineIndex === void 0) {
      throw new PatchError("invalid_content", `source-preserving insert_dataset_column requires a YAML schema block`, op);
    }
    const indent = yamlSchemaIndent(table);
    const insertAt = yamlSchemaInsertLineIndex(table, column);
    lines.splice(insertAt, 0, `${indent}${header}: ${schemaValue}`);
  }
  function deleteSourceYamlSchemaLine(lines, table, header, op) {
    const sourceLine = table.schemaLines.get(header);
    if (!sourceLine) {
      throw new PatchError("invalid_content", `source-preserving delete_dataset_column could not map YAML schema column "${header}"`, op);
    }
    lines.splice(sourceLine.index, 1);
  }
  function yamlSchemaIndent(table) {
    const sourceLine = table.schemaOrder[0];
    return sourceLine?.indent ?? `${table.schemaKeyIndent}  `;
  }
  function yamlSchemaInsertLineIndex(table, column) {
    const existingColumn = table.columns[column];
    const existing = existingColumn ? table.schemaLines.get(existingColumn) : void 0;
    if (existing) return existing.index;
    const previousColumn = table.columns[column - 1];
    const previous = previousColumn ? table.schemaLines.get(previousColumn) : void 0;
    if (previous) return previous.index + 1;
    return (table.schemaLineIndex ?? table.rowsLineIndex) + 1;
  }
  function rewriteSourceJsonColumnsLine(lines, table, op) {
    if (!table.columnsLine) {
      throw new PatchError("invalid_content", `source-preserving dataset column edits require a one-line JSON columns array`, op);
    }
    lines[table.columnsLine.index] = `${table.columnsLine.indent}${table.columnsLine.prefix}${JSON.stringify(table.columns)}${table.columnsLine.trailing}`;
  }
  function rewriteSourceJsonArrayDatasetRows(lines, table) {
    for (let i = 0; i < table.lines.length; i++) {
      const sourceLine = table.lines[i];
      const row = table.rows[i];
      if (row) lines[sourceLine.index] = `${sourceLine.indent}${JSON.stringify(row)}${sourceLine.trailing}`;
    }
  }
  function rewriteSourceJsonRecordDatasetRows(lines, table) {
    for (let i = table.lines.length - 1; i >= 0; i--) {
      const sourceRow = table.lines[i];
      const row = table.rows[i];
      if (!row) continue;
      const trailing = /\},?\s*$/.test(lines[sourceRow.end] ?? "") && (lines[sourceRow.end] ?? "").trim().endsWith(",") ? "," : "";
      lines.splice(sourceRow.start, sourceRow.end - sourceRow.start + 1, ...serializeJsonRecordRow(table.columns, row, sourceRow, trailing));
    }
  }
  function tableRowIndent(table, lineOffset) {
    const sourceLine = table.lines[lineOffset] ?? table.lines[Math.max(0, lineOffset - 1)] ?? table.lines[0];
    return sourceLine?.indent ?? "";
  }
  function tableInsertLineIndex(table, lineOffset, end) {
    const existing = table.lines[lineOffset];
    if (existing) return existing.index;
    const previous = table.lines[Math.max(0, lineOffset - 1)];
    return previous ? previous.index + 1 : end - 1;
  }
  function delimitedDatasetRowIndent(table, row) {
    const sourceLine = table.lines[row + 1] ?? table.lines[row] ?? table.lines[0];
    return sourceLine?.indent ?? "";
  }
  function delimitedDatasetInsertLineIndex(table, row, end) {
    const existing = table.lines[row + 1];
    if (existing) return existing.index;
    const previous = table.lines[row] ?? table.lines[0];
    return previous ? previous.index + 1 : end - 1;
  }
  function yamlDatasetRowIndent(table, row) {
    const sourceLine = table.lines[row] ?? table.lines[Math.max(0, row - 1)] ?? table.lines[0];
    return sourceLine?.indent ?? `${table.rowsKeyIndent}  `;
  }
  function yamlDatasetInsertLineIndex(table, row, end) {
    const existing = table.lines[row];
    if (existing) return existing.index;
    const previous = table.lines[Math.max(0, row - 1)];
    if (previous) return previous.index + 1;
    return table.rowsLineIndex >= 0 ? table.rowsLineIndex + 1 : end - 1;
  }
  function rewriteYamlRowsLineAsBlock(line, op) {
    const next = line.replace(
      /^(\s*rows\s*:)\s*\[\]\s*(#.*)?\s*$/,
      (_match, prefix, comment) => `${prefix}${comment ? ` ${comment}` : ""}`
    );
    if (next === line && /\[\]/.test(line)) return next;
    if (next === line && !/^\s*rows\s*:\s*(?:#.*)?$/.test(line)) {
      throw new PatchError("invalid_content", `source-preserving insert_dataset_row requires a block YAML rows array`, op);
    }
    return next;
  }
  function rewriteYamlRowsLineAsEmpty(line, op) {
    const next = line.replace(
      /^(\s*rows\s*:)(?:\s*(#.*))?\s*$/,
      (_match, prefix, comment) => `${prefix} []${comment ? ` ${comment}` : ""}`
    );
    if (next === line) {
      throw new PatchError("invalid_content", `source-preserving delete_dataset_row could not rewrite YAML rows as empty`, op);
    }
    return next;
  }
  function sourceDelimitedDatasetRows(sourceLines, start, end, delimiter, op) {
    const lines = [];
    const rows = [];
    for (let i = start; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      if (!line.trim()) continue;
      lines.push({ index: i, indent: line.match(/^\s*/)?.[0] ?? "" });
      rows.push(splitDelimitedRow(line.trim(), delimiter));
    }
    if (rows.length < 1) throw new PatchError("invalid_content", `dataset must have a header row`, op);
    return { columns: rows[0], rows: rows.slice(1), lines };
  }
  function sourceYamlDatasetRows(sourceLines, start, end, node, op) {
    const body = sourceLines.slice(start, end - 1).join("\n");
    const parsed = loadYamlDatasetText(body, node.id, op);
    const rows = parsed.rows;
    if (!Array.isArray(rows)) throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" has no rows array`, op);
    const lines = [];
    const parsedRows = [];
    let insideRows = false;
    let rowsIndent = -1;
    let rowsLineIndex = -1;
    let rowsKeyIndent = "";
    for (let i = start; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      if (!insideRows) {
        const rowsMatch = line.match(/^(\s*)rows\s*:/);
        if (rowsMatch) {
          insideRows = true;
          rowsIndent = indent.length;
          rowsLineIndex = i;
          rowsKeyIndent = rowsMatch[1] ?? "";
        }
        continue;
      }
      if (indent.length <= rowsIndent && !trimmed.startsWith("-")) break;
      const match = line.match(/^(\s*)-\s*(\[.*\])(\s+#.*)?\s*$/);
      if (!match) {
        if (trimmed.startsWith("-")) {
          throw new PatchError("invalid_content", `source-preserving dataset row edits require inline YAML row arrays`, op);
        }
        continue;
      }
      let row;
      try {
        row = jsYaml.load(match[2] ?? "");
      } catch {
        throw new PatchError("invalid_content", `dataset row is not valid YAML`, op);
      }
      if (!Array.isArray(row)) {
        throw new PatchError("invalid_content", `source-preserving dataset row edits require inline YAML row arrays`, op);
      }
      lines.push({ index: i, indent: match[1] ?? "", trailing: match[3] ?? "" });
      parsedRows.push([...row]);
    }
    if (parsedRows.length !== rows.filter(Array.isArray).length) {
      throw new PatchError("invalid_content", `source-preserving dataset row edits could not map every YAML row`, op);
    }
    if (rowsLineIndex === -1) {
      throw new PatchError("invalid_content", `source-preserving dataset row edits could not locate YAML rows`, op);
    }
    const schemaSource = sourceYamlSchemaLines(sourceLines, start, end);
    return {
      columns: datasetColumnsFromYaml(node, parsed, rows),
      rows: parsedRows,
      schema: recordValue(parsed.schema),
      lines,
      rowsLineIndex,
      rowsKeyIndent,
      ...schemaSource
    };
  }
  function sourceYamlSchemaLines(sourceLines, start, end) {
    const schemaLines = /* @__PURE__ */ new Map();
    const schemaOrder = [];
    let schemaLineIndex;
    let schemaIndent = -1;
    let schemaKeyIndent = "";
    for (let i = start; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      if (schemaLineIndex === void 0) {
        const schemaMatch = line.match(/^(\s*)schema\s*:/);
        if (schemaMatch) {
          schemaLineIndex = i;
          schemaIndent = indent.length;
          schemaKeyIndent = schemaMatch[1] ?? "";
        }
        continue;
      }
      if (indent.length <= schemaIndent && /^[A-Za-z_][\w-]*\s*:/.test(trimmed)) break;
      const propertyMatch = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:/);
      if (!propertyMatch || indent.length <= schemaIndent) continue;
      const key = propertyMatch[2] ?? "";
      const sourceLine = { key, index: i, indent: propertyMatch[1] ?? "" };
      schemaLines.set(key, { index: i, indent: sourceLine.indent });
      schemaOrder.push(sourceLine);
    }
    return { schemaLineIndex, schemaKeyIndent, schemaLines, schemaOrder };
  }
  function serializeYamlFlowRow(cells) {
    return jsYaml.dump(cells, { flowLevel: 0, lineWidth: -1, noRefs: true }).trim();
  }
  function sourceJsonDatasetRows(sourceLines, start, end, node, op) {
    const body = sourceLines.slice(start, end - 1).join("\n");
    const table = parseJsonDatasetText(body, node, op);
    if (table.sourceShape === "records") {
      const sourceRows2 = sourceJsonRecordRows(sourceLines, start, end, table.columns, op);
      if (sourceRows2.lines.length !== table.rows.length) {
        throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not map every JSON record row`, op);
      }
      return { ...table, sourceShape: "records", ...sourceRows2 };
    }
    const sourceRows = sourceJsonArrayRows(sourceLines, start, end, table.sourceShape === "object", op);
    if (sourceRows.lines.length !== table.rows.length) {
      throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not map every JSON row array`, op);
    }
    return { ...table, sourceShape: table.sourceShape === "object" ? "object" : "arrays", ...sourceRows };
  }
  function sourceJsonArrayRows(sourceLines, start, end, objectRows, op) {
    const bounds = sourceJsonArrayBounds(sourceLines, start, end, objectRows, op);
    const out = [];
    for (let i = bounds.rowsStartIndex + 1; i < bounds.rowsEndIndex; i++) {
      const line = sourceLines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed.startsWith("[") || trimmed === "[" || trimmed === "],") continue;
      const trailing = trimmed.endsWith(",") ? "," : "";
      const candidate = trailing ? trimmed.slice(0, -1).trimEnd() : trimmed;
      let parsed;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      out.push({ index: i, indent: line.match(/^\s*/)?.[0] ?? "", trailing });
    }
    const rowIndent = out[0]?.indent ?? bounds.rowIndent;
    return { lines: out, rowsStartIndex: bounds.rowsStartIndex, rowsEndIndex: bounds.rowsEndIndex, rowIndent, inlineEmptyRowsLine: bounds.inlineEmptyRowsLine, columnsLine: bounds.columnsLine };
  }
  function sourceJsonArrayBounds(sourceLines, start, end, objectRows, op) {
    let columnsLine;
    for (let i = start; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      const trimmed = line.trim();
      const indent = line.match(/^\s*/)?.[0] ?? "";
      if (objectRows) {
        const columnsMatch = line.match(/^(\s*)("columns"\s*:\s*)(\[.*\])(\s*,?)\s*$/);
        if (columnsMatch) {
          try {
            if (Array.isArray(JSON.parse(columnsMatch[3] ?? ""))) {
              columnsLine = {
                index: i,
                indent: columnsMatch[1] ?? "",
                prefix: columnsMatch[2] ?? '"columns": ',
                trailing: columnsMatch[4] ?? ""
              };
            }
          } catch {
          }
        }
        const inlineEmpty = line.match(/^(\s*)("rows"\s*:\s*)\[\]\s*(,?)\s*$/);
        if (inlineEmpty) {
          return {
            rowsStartIndex: i,
            rowsEndIndex: i,
            rowIndent: `${indent}  `,
            columnsLine,
            inlineEmptyRowsLine: {
              index: i,
              indent: inlineEmpty[1] ?? "",
              prefix: inlineEmpty[2] ?? '"rows": ',
              trailing: inlineEmpty[3] ?? ""
            }
          };
        }
        if (!/^"rows"\s*:\s*\[\s*$/.test(trimmed)) continue;
      } else if (trimmed !== "[") {
        continue;
      }
      for (let close = i + 1; close < end - 1; close++) {
        const closeLine = sourceLines[close] ?? "";
        if (/^\s*\]\s*,?\s*$/.test(closeLine)) {
          return {
            rowsStartIndex: i,
            rowsEndIndex: close,
            rowIndent: `${indent}  `,
            columnsLine
          };
        }
      }
      break;
    }
    throw new PatchError("invalid_content", `source-preserving dataset row edits require a mappable JSON row array`, op);
  }
  function jsonDatasetInsertLineIndex(table, row) {
    const existing = table.lines[row];
    if (existing) return existing.index;
    const previous = table.lines[Math.max(0, row - 1)];
    if (previous) return previous.index + 1;
    return table.rowsEndIndex;
  }
  function ensureJsonTrailingComma(line) {
    return /,\s*$/.test(line) ? line : line.replace(/\s*$/, ",");
  }
  function removeJsonTrailingComma(line) {
    return line.replace(/,\s*$/, "");
  }
  function sourceJsonRecordRows(sourceLines, start, end, columns, op) {
    const bounds = sourceJsonRecordArrayBounds(sourceLines, start, end, op);
    const out = [];
    for (let i = bounds.rowsStartIndex + 1; i < bounds.rowsEndIndex; i++) {
      const line = sourceLines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      const block = jsonObjectBlock(sourceLines, i, bounds.rowsEndIndex + 1);
      if (!block) continue;
      const candidate = stripJsonTrailingComma(block.lines.join("\n"));
      let parsed;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (!recordValue(parsed)) continue;
      const propertyLines = /* @__PURE__ */ new Map();
      if (block.lines.length === 1) {
        for (const column of columns) {
          if (jsonLineHasProperty(block.lines[0] ?? "", column)) propertyLines.set(column, i);
        }
      } else {
        for (let offset = 0; offset < block.lines.length; offset++) {
          const sourceLine = block.lines[offset] ?? "";
          for (const column of columns) {
            if (jsonLineHasProperty(sourceLine, column)) propertyLines.set(column, i + offset);
          }
        }
      }
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const propertyIndent = jsonRecordPropertyIndent(block.lines, indent);
      if (propertyLines.size > 0) {
        out.push({
          propertyLines,
          start: i,
          end: block.end,
          indent,
          propertyIndent,
          multiline: block.lines.length > 1
        });
      }
      i = block.end;
    }
    if (out.length === 0) {
      throw new PatchError("invalid_content", `source-preserving update_dataset_cell requires mappable JSON record rows`, op);
    }
    return {
      lines: out,
      rowsStartIndex: bounds.rowsStartIndex,
      rowsEndIndex: bounds.rowsEndIndex,
      rowIndent: out[0]?.indent ?? bounds.rowIndent,
      propertyIndent: out[0]?.propertyIndent ?? `${bounds.rowIndent}  `
    };
  }
  function sourceJsonRecordArrayBounds(sourceLines, start, end, op) {
    for (let i = start; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      const trimmed = line.trim();
      if (trimmed !== "[") continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      for (let close = i + 1; close < end - 1; close++) {
        const closeLine = sourceLines[close] ?? "";
        if (/^\s*\]\s*$/.test(closeLine)) {
          return { rowsStartIndex: i, rowsEndIndex: close, rowIndent: `${indent}  ` };
        }
      }
      break;
    }
    throw new PatchError("invalid_content", `source-preserving dataset row edits require a mappable JSON record array`, op);
  }
  function jsonRecordPropertyIndent(lines, rowIndent) {
    for (const line of lines.slice(1, -1)) {
      if (jsonLineHasAnyProperty(line)) return line.match(/^\s*/)?.[0] ?? `${rowIndent}  `;
    }
    return `${rowIndent}  `;
  }
  function jsonLineHasAnyProperty(line) {
    return /"(?:(?:\\.)|[^"\\])*"\s*:/.test(line);
  }
  function jsonRecordDatasetInsertLineIndex(table, row) {
    const existing = table.lines[row];
    if (existing) return existing.start;
    const previous = table.lines[Math.max(0, row - 1)];
    if (previous) return previous.end + 1;
    return table.rowsEndIndex;
  }
  function jsonRecordReferenceRow(table, row) {
    const sourceRow = table.lines[row] ?? table.lines[Math.max(0, row - 1)] ?? table.lines[0];
    if (!sourceRow) {
      return {
        propertyLines: /* @__PURE__ */ new Map(),
        start: table.rowsStartIndex,
        end: table.rowsStartIndex,
        indent: table.rowIndent,
        propertyIndent: table.propertyIndent,
        multiline: false
      };
    }
    return sourceRow;
  }
  function serializeJsonRecordRow(columns, cells, reference, trailing) {
    const pairs2 = columns.map((column, index) => [column, cells[index] ?? null]);
    if (!reference.multiline) {
      const fields = pairs2.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ");
      return [`${reference.indent}{ ${fields} }${trailing}`];
    }
    const lines = [`${reference.indent}{`];
    pairs2.forEach(([key, value], index) => {
      const comma = index === pairs2.length - 1 ? "" : ",";
      lines.push(`${reference.propertyIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    });
    lines.push(`${reference.indent}}${trailing}`);
    return lines;
  }
  function jsonObjectBlock(sourceLines, startIndex, end) {
    const first = sourceLines[startIndex] ?? "";
    const firstTrimmed = first.trim();
    if (firstTrimmed.includes("}") && stripJsonTrailingComma(firstTrimmed).endsWith("}")) {
      return { end: startIndex, lines: [first] };
    }
    const lines = [];
    for (let i = startIndex; i < end - 1; i++) {
      const line = sourceLines[i] ?? "";
      lines.push(line);
      if (line.trim().startsWith("}")) return { end: i, lines };
    }
    return void 0;
  }
  function stripJsonTrailingComma(text) {
    return text.replace(/,\s*$/, "");
  }
  function jsonLineHasProperty(line, key) {
    return new RegExp(`${escapeRegExp(JSON.stringify(key))}\\s*:`).test(line);
  }
  function rewriteJsonPropertyLine(line, key, value, op) {
    const literal = JSON.stringify(value ?? null);
    const valuePattern = `"(?:(?:\\\\.)|[^"\\\\])*"|true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`;
    const pattern = new RegExp(`(${escapeRegExp(JSON.stringify(key))}\\s*:\\s*)(?:${valuePattern})(\\s*(?:,|}|$))`);
    const next = line.replace(pattern, (_match, prefix, suffix) => `${prefix}${literal}${suffix}`);
    if (next === line) {
      throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not rewrite JSON property "${key}"`, op);
    }
    return next;
  }
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function applySrcMove(source, op) {
    const doc = parse(source);
    const node = findById(doc, op.id);
    if (!node) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
    if (!isDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" is not a directive block`, op);
    }
    const parent = findById(doc, op.parent);
    if (!parent) throw new PatchError("parent_missing", `parent "${op.parent}" not found`, op);
    if (!hasChildren(parent)) {
      throw new PatchError("parent_missing", `parent "${op.parent}" cannot have children`, op);
    }
    if (containsId(node, op.parent)) {
      throw new PatchError("invalid_content", `cannot move "${op.id}" into itself or its descendants`, op);
    }
    const start = node.pos?.line;
    const end = node.endLine;
    if (!start || !end) throw new Error(`block "${op.id}" has no source span`);
    const lines = source.split("\n");
    const sourceDepth = directiveFenceDepth(node, lines);
    const targetDepth = parent.type === "directive" ? directiveFenceDepth(parent, lines) + 1 : 2;
    const content = normalizeDirectiveFenceDepth(
      lines.slice(start - 1, end).join("\n"),
      sourceDepth,
      targetDepth
    );
    let deleted = applySrcDelete(source, { op: "delete_block", id: op.id });
    if (start === 1 && deleted.startsWith("\n")) deleted = deleted.slice(1);
    return applySrcAdd(deleted, {
      op: "add_block",
      parent: op.parent,
      content,
      ...op.position !== void 0 ? { position: op.position } : {}
    });
  }
  function directiveFenceDepth(node, lines) {
    const start = node.pos?.line;
    const line = start ? lines[start - 1] : void 0;
    return line?.match(/^\s*(:{2,})/)?.[1]?.length ?? 2;
  }
  function normalizeDirectiveFenceDepth(content, from, to) {
    if (from === to) return content;
    const delta = to - from;
    let inFence = false;
    return content.split("\n").map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = line.match(/^(\s*)(:{2,})(.*)$/);
      if (!match) return line;
      const rest = match[3] ?? "";
      if (!/^\s*(?:[a-zA-Z_]|$)/.test(rest)) return line;
      const depth = match[2].length;
      if (depth < from) return line;
      return `${match[1] ?? ""}${":".repeat(Math.max(2, depth + delta))}${rest}`;
    }).join("\n");
  }
  function applySrcRenameId(source, op) {
    const doc = parse(source);
    const node = findById(doc, op.from);
    if (!node) throw new PatchError("target_missing", `block "${op.from}" not found`, op);
    if (findById(doc, op.to)) {
      throw new PatchError("id_conflict", `target id "${op.to}" already exists`, op);
    }
    const lines = source.split("\n");
    const startLine = node.pos?.line;
    if (!startLine) throw new Error(`block has no source span`);
    const lineIdx = startLine - 1;
    const open = lines[lineIdx] ?? "";
    if (isDirective(node)) {
      lines[lineIdx] = rewriteOpenLineAttr(open, "id", op.to, op);
    } else if (node.type === "section") {
      lines[lineIdx] = rewriteHeadingId(open, op.to);
    }
    let result = lines.join("\n");
    result = rewriteWikilinksInSource(result, op.from, op.to);
    result = rewriteAttrReferences(result, op.from, op.to);
    return result;
  }
  var REF_ATTRS = /* @__PURE__ */ new Set(["for", "parent", "dataset", "block", "ref"]);
  function rewriteAttrReferences(source, from, to) {
    const escFrom = escapeRegex(from);
    return source.split("\n").map((line) => {
      if (!/^:{2,}\w/.test(line.trim())) return line;
      let out = line;
      for (const k of REF_ATTRS) {
        const quoted = new RegExp(`(\\b${k}=)("|')${escFrom}\\2`, "g");
        out = out.replace(quoted, `$1$2${to}$2`);
        const bare = new RegExp(`(\\b${k}=)${escFrom}(?=[\\s}])`, "g");
        out = out.replace(bare, `$1"${to}"`);
      }
      return out;
    }).join("\n");
  }
  function rewriteWikilinksInSource(source, from, to) {
    return source.replace(
      new RegExp(`\\[\\[${escapeRegex(from)}\\]\\]`, "g"),
      `[[${to}]]`
    );
  }
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  var ATTR_TOKEN_RE = /([a-zA-Z_][\w-]*)(?:=("([^"]*)"|'([^']*)'|([^\s}]+)))?/g;
  function rewriteOpenLineAttr(line, key, value, op) {
    const openMatch = line.match(/^(\s*:{2,}\s*[a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)(\s*\{)?(.*?)(\}\s*)?$/);
    if (!openMatch) {
      throw new PatchError("invalid_content", `malformed open line for "${op.id}"`, op);
    }
    const head = openMatch[1] ?? "";
    const inner = openMatch[3] ?? "";
    const trailing = (line.match(/\s*$/) ?? [""])[0];
    const serialized = serializeOneAttr(key, value);
    let replaced = false;
    const rewrittenInner = inner.replace(ATTR_TOKEN_RE, (m, k) => {
      if (k !== key) return m;
      replaced = true;
      return value === false && typeof value === "boolean" ? `${key}=false` : serialized;
    });
    let next;
    if (replaced) {
      next = rewrittenInner;
    } else {
      const trimmed = inner.trim();
      next = trimmed ? `${trimmed} ${serialized}` : serialized;
    }
    return `${head}{${next.trim()}}${trailing}`.replace(/\s+$/, "") + (line.endsWith("\n") ? "\n" : "");
  }
  function rewriteOpenLineRemoveAttr(line, key, op) {
    const openMatch = line.match(/^(\s*:{2,}\s*[a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)(\s*\{)?(.*?)(\}\s*)?$/);
    if (!openMatch) {
      throw new PatchError("invalid_content", `malformed open line for "${op.id}"`, op);
    }
    const head = openMatch[1] ?? "";
    const inner = openMatch[3] ?? "";
    const trailing = (line.match(/\s*$/) ?? [""])[0];
    let removed = false;
    const kept = [];
    inner.replace(ATTR_TOKEN_RE, (m, k) => {
      if (k !== key) {
        kept.push(m);
        return m;
      }
      removed = true;
      return "";
    });
    const rewrittenInner = kept.join(" ").trim();
    if (!removed) return line;
    if (!rewrittenInner) {
      return `${head}${trailing}`.replace(/\s+$/, "") + (line.endsWith("\n") ? "\n" : "");
    }
    return `${head}{${rewrittenInner}}${trailing}`.replace(/\s+$/, "") + (line.endsWith("\n") ? "\n" : "");
  }
  function rewriteCommentResolutionAttrs(line, op) {
    let next = rewriteOpenLineAttr(line, "status", "resolved", op);
    if (op.resolved_by) next = rewriteOpenLineAttr(next, "resolved_by", op.resolved_by, op);
    if (op.resolved_at) next = rewriteOpenLineAttr(next, "resolved_at", op.resolved_at, op);
    return next;
  }
  function rewriteHeadingId(line, newId) {
    const m = line.match(/^(#+\s+.+?)(?:\s+\{([^}]*)\})?\s*$/);
    if (!m) return line;
    const head = m[1] ?? "";
    const attrsInner = (m[2] ?? "").trim();
    if (!attrsInner) return `${head} {id="${newId}"}`;
    let replaced = false;
    const updated = attrsInner.replace(ATTR_TOKEN_RE, (full, k) => {
      if (k !== "id") return full;
      replaced = true;
      return `id="${newId}"`;
    });
    if (!replaced) return `${head} {${attrsInner} id="${newId}"}`;
    return `${head} {${updated.trim()}}`;
  }
  function rewriteHeadingTitle(line, newTitle, stableId) {
    const m = line.match(/^(#+)(\s+)(.*?)(?:\s+\{([^}]*)\})?\s*$/);
    if (!m) return line;
    const hashes = m[1] ?? "#";
    const space = m[2] ?? " ";
    const attrsInner = (m[4] ?? "").trim();
    const needsExplicitId = stableId && stableId.length > 0 && slugify(newTitle) !== stableId;
    if (!attrsInner) {
      return needsExplicitId ? `${hashes}${space}${newTitle} {id="${stableId}"}` : `${hashes}${space}${newTitle}`;
    }
    let hasId = false;
    attrsInner.replace(ATTR_TOKEN_RE, (_full, k) => {
      if (k === "id") hasId = true;
      return _full;
    });
    const attrs = needsExplicitId && !hasId ? `${attrsInner} id="${stableId}"` : attrsInner;
    return `${hashes}${space}${newTitle} {${attrs.trim()}}`;
  }
  function serializeCommentBlock(op) {
    if (!op.content.trim()) {
      throw new PatchError("invalid_content", `comment content must not be empty`, op);
    }
    const attrs = Object.entries(commentAttrs(op)).map(([key, value]) => serializeOneAttr(key, value)).join(" ");
    const content = op.content.replace(/\n+$/, "");
    const source = `::comment{${attrs}}
${content}
::`;
    parseFragment(source, op);
    return source;
  }
  function serializeNoteBlock(op) {
    validateNoteOp(op);
    const attrs = Object.entries(noteAttrs(op)).map(([key, value]) => serializeOneAttr(key, value)).join(" ");
    const content = op.content.replace(/\n+$/, "");
    const source = `::${op.op === "add_footnote" ? "footnote" : "endnote"}{${attrs}}
${content}
::`;
    parseFragment(source, op);
    return source;
  }
  function serializeChangeRequestBlock(op) {
    validateChangeRequestOp(op);
    const attrs = Object.entries(changeRequestAttrs(op)).map(([key, value]) => serializeOneAttr(key, value)).join(" ");
    const content = op.content?.replace(/\n+$/, "") ?? "";
    const source = content ? `::change_request{${attrs}}
${content}
::` : `::change_request{${attrs}}
::`;
    parseFragment(source, op);
    return source;
  }
  function serializeOneAttr(key, value) {
    if (value === true) return key;
    if (value === false) return `${key}=false`;
    if (typeof value === "number") return `${key}=${value}`;
    const s = String(value);
    if (s.includes('"')) {
      if (s.includes("'")) return `${key}="${s.replace(/"/g, '\\"')}"`;
      return `${key}='${s}'`;
    }
    return `${key}="${s}"`;
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
    const pattern = new RegExp(`^\\s*${escapeRegExp2(key)}\\s*:`, "i");
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
  function escapeRegExp2(value) {
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
<link rel="icon" href="data:," />
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
  var SVG_SANITIZE_JS = `function nomaSanitizedSvg(markup) {
  const tpl = document.createElement("template");
  tpl["inn" + "erHTML"] = markup;
  tpl.content.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
  tpl.content.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/\\s+/g, "").toLowerCase();
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      else if ((name === "href" || name === "xlink:href" || name === "src") && value.startsWith("javascript:")) node.removeAttribute(attr.name);
    }
  });
  return tpl.content;
}`;
  var MERMAID_FOOT = `
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs";
${SVG_SANITIZE_JS}
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
const els = document.querySelectorAll(".noma-diagram-mermaid");
for (let i = 0; i < els.length; i++) {
  const el = els[i];
  const src = el.getAttribute("data-noma-source");
  if (!src) continue;
  try {
    const out = await mermaid.render("noma-mermaid-" + i, src);
    el.replaceChildren(nomaSanitizedSvg(out.svg));
  } catch (e) { el.textContent = String(e); }
}
<\/script>`;
  var VIZ_FOOT = `
<script type="module">
import("https://cdn.jsdelivr.net/npm/@viz-js/viz@${VIZ_VERSION}/lib/viz-standalone.mjs").then(({ instance }) => instance().then((viz) => {
  ${SVG_SANITIZE_JS}
  document.querySelectorAll(".noma-diagram-graphviz, .noma-diagram-dot").forEach((el) => {
    const src = el.getAttribute("data-noma-source");
    if (!src) return;
    try { el.replaceChildren(nomaSanitizedSvg(viz.renderString(src, { format: "svg" }))); }
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
  var WIKILINK_RE2 = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;
  function filterMemoryIndexBody(body, excluded) {
    if (excluded.size === 0) return body;
    return body.split("\n").filter((line) => {
      const matches = [...line.matchAll(WIKILINK_RE2)];
      if (matches.length === 0) return true;
      return !matches.every((m) => excluded.has(m[1]));
    }).join("\n");
  }
  function emitFilteredIndexChild(node, out, depth, opts) {
    if (node.type === "list") {
      const survivors = node.items.filter((item) => {
        const matches = [...item.content.matchAll(WIKILINK_RE2)];
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
      const matches = [...node.content.matchAll(WIKILINK_RE2)];
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
  var technicalProfile = PROFILES.technical;
  var researchProfile = PROFILES.research;
  var memoryProfile = PROFILES.memory;
  var minimalProfile = PROFILES.minimal;
  PROFILES["technical-docs"] = technicalProfile;
  PROFILES["research-memo"] = researchProfile;
  PROFILES["investment-thesis"] = researchProfile;
  PROFILES["agent-memory"] = memoryProfile;
  PROFILES.adr = /* @__PURE__ */ new Set([
    ...minimalProfile,
    "decision",
    "adr",
    "risk",
    "open_question",
    "assumption",
    "evidence",
    "counterevidence",
    "comment",
    "change_request",
    "agent_task",
    "todo",
    "citation",
    "state_change"
  ]);
  PROFILES.spec = /* @__PURE__ */ new Set([...technicalProfile, ...researchProfile]);
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
    const refSites = [];
    const datasetIds = /* @__PURE__ */ new Map();
    const datasetColumns = /* @__PURE__ */ new Map();
    const controls = /* @__PURE__ */ new Map();
    const computed = /* @__PURE__ */ new Map();
    const computedNodes = [];
    const adrNodes = [];
    const aliasToNode = /* @__PURE__ */ new Map();
    const declaredProfiles = readDeclaredProfiles(doc.meta, options.profiles);
    const activeProfiles = new Set(declaredProfiles);
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
    const wikilinkRefs = /* @__PURE__ */ new Set();
    const collectWikilinks = (text, node) => {
      for (const link of extractWikilinks(text)) {
        if (!isBlockReferenceWikilinkTarget(link.target)) continue;
        referenced.add(link.target);
        wikilinkRefs.add(link.target);
        refSites.push({ target: link.target, node });
      }
    };
    for (const node of walk(doc)) {
      if (node.type === "paragraph" || node.type === "quote") collectWikilinks(node.content, node);
      else if (node.type === "list_item") collectWikilinks(node.content, node);
      else if (node.type === "section") collectWikilinks(node.title, node);
      else if (node.type === "directive" && node.body) collectWikilinks(node.body, node);
      else if (node.type === "table") {
        for (const cell of node.header) collectWikilinks(cell, node);
        for (const row of node.rows) for (const cell of row) collectWikilinks(cell, node);
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
      if (node.name === "decision" || node.name === "adr") adrNodes.push(node);
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
      if (node.name === "claim" && !suppressed(node) && (activeProfiles.has("research-memo") || activeProfiles.has("investment-thesis")) && !("confidence" in node.attrs)) {
        diagnostics.push({
          severity: "warning",
          code: "claim-missing-confidence",
          message: `Claim "${node.id ?? "?"}" has no \`confidence=\` attribute required by the research-style profile.`,
          pos: node.pos,
          nodeId: node.id
        });
      }
      if (node.name === "state_change" && !suppressed(node)) {
        const block = node.attrs.block;
        if (typeof block === "string") {
          referenced.add(block);
          refSites.push({ target: block, node, attrKey: "block" });
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
        const target = readFirstStringAttrEntry(node, ["target", "for", "parent", "block", "ref"]);
        if (target) {
          referenced.add(target.value);
          refSites.push({ target: target.value, node, attrKey: target.key });
        }
        const replyTo = readFirstStringAttrEntry(node, ["reply_to", "replyTo", "reply"]);
        if (replyTo) {
          referenced.add(replyTo.value);
          refSites.push({ target: replyTo.value, node, attrKey: replyTo.key });
        }
      }
      if (node.name === "change_request" && !suppressed(node)) {
        const target = readFirstStringAttrEntry(node, ["target", "for", "parent", "block"]);
        if (target) {
          referenced.add(target.value);
          refSites.push({ target: target.value, node, attrKey: target.key });
        }
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
        const target = readFirstStringAttrEntry(node, ["target", "for", "parent", "block", "ref"]);
        if (target) {
          referenced.add(target.value);
          refSites.push({ target: target.value, node, attrKey: target.key });
        }
      }
      if (node.name === "evidence" || node.name === "counterevidence") {
        const target = node.attrs.for;
        if (typeof target === "string") {
          referenced.add(target);
          evidenceTargets.add(target);
          refSites.push({ target, node, attrKey: "for" });
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
      if ((node.name === "decision" || node.name === "adr") && activeProfiles.has("adr") && !suppressed(node)) {
        if (!node.attrs.owner) {
          diagnostics.push({
            severity: "warning",
            code: "adr-missing-owner",
            message: `${node.name} "${node.id ?? "?"}" has no \`owner=\` attribute required by the adr profile.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
        if (!node.attrs.date && !node.attrs.decided_at && !node.attrs.decidedAt) {
          diagnostics.push({
            severity: "warning",
            code: "adr-missing-date",
            message: `${node.name} "${node.id ?? "?"}" has no \`date=\` or \`decided_at=\` attribute required by the adr profile.`,
            pos: node.pos,
            nodeId: node.id
          });
        }
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
      if (ids.has(target) || aliasIds.has(target)) continue;
      const suggestion = nearestId(target, [...ids.keys(), ...aliasIds]);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      const sites2 = refSites.filter((site) => site.target === target);
      if (sites2.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "broken-reference",
          message: `Reference to unknown block ID "${target}".${hint}`
        });
        continue;
      }
      for (const site of sites2) {
        diagnostics.push({
          severity: "error",
          code: "broken-reference",
          message: `Reference to unknown block ID "${target}".${hint}`,
          pos: site.node.pos,
          nodeId: site.node.id,
          ...suggestion && site.attrKey && site.node.id ? {
            fix: {
              op: "update_attribute",
              id: site.node.id,
              key: site.attrKey,
              value: suggestion
            }
          } : {}
        });
      }
    }
    if (activeProfiles.has("memory") || activeProfiles.has("agent-memory")) {
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
    if (activeProfiles.has("adr") && adrNodes.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "adr-missing-decision",
        message: `ADR profile expects at least one ::decision or ::adr block.`
      });
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
    for (const diagnostic of diagnostics) {
      if (diagnostic.endLine !== void 0 || !diagnostic.nodeId) continue;
      const node = ids.get(diagnostic.nodeId) ?? aliasToNode.get(diagnostic.nodeId);
      if (node?.endLine !== void 0) diagnostic.endLine = node.endLine;
    }
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
  function readDeclaredProfiles(meta, optionProfiles = []) {
    const out = [];
    const add = (value) => {
      if (typeof value !== "string") return;
      for (const p of value.split(/[,\s]+/)) {
        const trimmed = p.trim();
        if (trimmed && !out.includes(trimmed)) out.push(trimmed);
      }
    };
    if (Array.isArray(meta.profiles)) {
      for (const p of meta.profiles) add(p);
    }
    if (typeof meta.profile === "string" && meta.profile.trim()) {
      add(meta.profile);
    }
    for (const profile of optionProfiles) add(profile);
    return out;
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
    "claim-missing-confidence",
    "adr-missing-owner",
    "adr-missing-date",
    "adr-missing-decision",
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
    return readFirstStringAttrEntry(node, keys)?.value;
  }
  function readFirstStringAttrEntry(node, keys) {
    for (const key of keys) {
      const value = node.attrs[key];
      if (typeof value === "string" && value.trim()) return { key, value: value.trim() };
    }
    return void 0;
  }
  function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = prev[j];
        prev[j] = Math.min(cur + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = cur;
      }
    }
    return prev[b.length];
  }
  function nearestId(target, candidates) {
    let best;
    let bestDistance = 3;
    for (const candidate of candidates) {
      const distance = levenshtein(target, candidate);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      } else if (distance === bestDistance && best !== void 0) {
        best = void 0;
        bestDistance = distance;
      }
    }
    return bestDistance <= 2 && target.length > 3 ? best : void 0;
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
  var default_default = ':root {\n  --noma-bg: #fbfaf7;\n  --noma-fg: #1d1c1a;\n  --noma-muted: #6b6a66;\n  --noma-rule: #e7e4dc;\n  --noma-accent: #b9522a;\n  --noma-accent-soft: #f4dccd;\n  --noma-claim: #2c5d8f;\n  --noma-claim-soft: #dfeaf5;\n  --noma-evidence: #2f7d4a;\n  --noma-evidence-soft: #dff0e3;\n  --noma-risk: #a8362e;\n  --noma-risk-soft: #f7d9d4;\n  --noma-code-bg: #f1ede4;\n  --noma-card-bg: #ffffff;\n  --noma-shadow: 0 1px 0 rgba(0, 0, 0, 0.04), 0 8px 24px -16px rgba(20, 20, 20, 0.18);\n  --noma-radius: 8px;\n  --noma-cols: 2;\n  --noma-grid-min: 14rem;\n  --noma-grid-gap: 1rem;\n  --noma-font-serif: "Iowan Old Style", "Charter", Georgia, serif;\n  --noma-font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;\n  --noma-font-mono: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;\n}\n\n* { box-sizing: border-box; }\n\nhtml, body {\n  margin: 0;\n  padding: 0;\n  background: var(--noma-bg);\n  color: var(--noma-fg);\n  font-family: var(--noma-font-serif);\n  font-size: 16px;\n  line-height: 1.58;\n  -webkit-font-smoothing: antialiased;\n  text-rendering: optimizeLegibility;\n}\n\nmain.noma-doc {\n  max-width: 1040px;\n  margin: 3rem auto;\n  padding: 0 1.25rem 5rem;\n}\n\nmain.noma-doc > section.noma-hero ~ section,\nmain.noma-doc > .noma-grid,\nmain.noma-doc > .noma-columns {\n  max-width: 100%;\n}\n\nh1, h2, h3, h4, h5, h6 {\n  font-family: var(--noma-font-sans);\n  font-weight: 700;\n  line-height: 1.2;\n  letter-spacing: 0;\n  margin: 2em 0 0.55em;\n}\nh1 { font-size: 2.1rem; margin-top: 0; }\nh2 { font-size: 1.45rem; border-bottom: 1px solid var(--noma-rule); padding-bottom: 0.25em; }\nh3 { font-size: 1.15rem; }\nh4 { font-size: 0.98rem; color: var(--noma-muted); text-transform: uppercase; letter-spacing: 0.04em; }\n\np { margin: 0 0 1.05em; }\na { color: var(--noma-accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }\na:hover { text-decoration-thickness: 2px; }\n\ncode {\n  font-family: var(--noma-font-mono);\n  font-size: 0.9em;\n  background: var(--noma-code-bg);\n  padding: 0.1em 0.35em;\n  border-radius: 4px;\n}\npre {\n  background: var(--noma-code-bg);\n  padding: 1em 1.2em;\n  border-radius: var(--noma-radius);\n  overflow-x: auto;\n  font-size: 0.9rem;\n  line-height: 1.5;\n}\npre code { background: none; padding: 0; }\n\nblockquote {\n  border-left: 3px solid var(--noma-accent);\n  margin: 1.5em 0;\n  padding: 0.2em 1.2em;\n  color: var(--noma-muted);\n  font-style: italic;\n}\n\nhr { border: 0; border-top: 1px solid var(--noma-rule); margin: 3em 0; }\n\nul, ol { padding-left: 1.4em; }\nli { margin: 0.25em 0; }\n\nfigure {\n  margin: 1.8em 0;\n}\nfigure img {\n  display: block;\n  max-width: 100%;\n  height: auto;\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\nfigcaption {\n  margin-top: 0.65em;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n\n/* Callouts */\naside.noma-callout {\n  margin: 1.6em 0;\n  padding: 1em 1.2em;\n  border-radius: var(--noma-radius);\n  background: var(--noma-accent-soft);\n  border-left: 3px solid var(--noma-accent);\n}\naside.noma-callout-warning { background: #fbe6df; border-color: var(--noma-risk); }\naside.noma-callout-tip     { background: #e6f3eb; border-color: var(--noma-evidence); }\naside.noma-callout-note    { background: #ecedf2; border-color: #5a6071; }\n\n/* Research blocks */\naside.noma-research {\n  margin: 1.6em 0;\n  padding: 1em 1.2em;\n  border-radius: var(--noma-radius);\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  box-shadow: var(--noma-shadow);\n}\naside.noma-research .noma-research-head {\n  display: flex;\n  align-items: center;\n  gap: 0.8em;\n  margin-bottom: 0.5em;\n}\naside.noma-research .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--noma-muted);\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: var(--noma-code-bg);\n}\naside.noma-claim          { border-left: 3px solid var(--noma-claim); }\naside.noma-claim .noma-tag { color: var(--noma-claim); background: var(--noma-claim-soft); }\naside.noma-evidence       { border-left: 3px solid var(--noma-evidence); }\naside.noma-evidence .noma-tag { color: var(--noma-evidence); background: var(--noma-evidence-soft); }\naside.noma-counterevidence { border-left: 3px solid var(--noma-risk); }\naside.noma-counterevidence .noma-tag { color: var(--noma-risk); background: var(--noma-risk-soft); }\naside.noma-risk           { border-left: 3px solid var(--noma-risk); }\naside.noma-risk .noma-tag  { color: var(--noma-risk); background: var(--noma-risk-soft); }\naside.noma-decision, aside.noma-adr { border-left: 3px solid var(--noma-accent); }\naside.noma-decision .noma-tag, aside.noma-adr .noma-tag { color: var(--noma-accent); background: var(--noma-accent-soft); }\naside.noma-open_question { border-left: 3px solid #8b6c1a; }\naside.noma-open_question .noma-tag { color: #8b6c1a; background: #f5ebcf; }\naside.noma-assumption { border-left: 3px solid #5a6071; }\naside.noma-assumption .noma-tag { color: #5a6071; background: #ecedf2; }\n\n/* Variants \u2014 themable per-block emphasis without inline styling */\n[data-variant="important"] { border-width: 5px !important; box-shadow: 0 0 0 1px var(--noma-accent) inset, var(--noma-shadow); }\n[data-variant="subtle"] { opacity: 0.78; box-shadow: none; }\n[data-variant="success"] { border-left: 3px solid var(--noma-evidence); background: var(--noma-evidence-soft); }\n[data-variant="danger"]  { border-left: 3px solid var(--noma-risk); background: var(--noma-risk-soft); }\n[data-variant="info"]    { border-left: 3px solid var(--noma-claim); background: var(--noma-claim-soft); }\n\n/* Export buttons (artifact-side action surface) */\n.noma-export-button {\n  display: inline-block;\n  background: var(--noma-fg);\n  color: var(--noma-bg);\n  border: 0;\n  padding: 0.55em 1.1em;\n  margin: 0.3em 0.4em 0.3em 0;\n  border-radius: 999px;\n  font-family: var(--noma-font-sans);\n  font-weight: 600;\n  font-size: 0.85rem;\n  cursor: pointer;\n  transition: background 120ms ease;\n}\n.noma-export-button:hover { background: var(--noma-accent); color: white; }\n.noma-export-button[data-format="prompt"] { background: var(--noma-claim); }\n.noma-export-button[data-format="markdown"] { background: var(--noma-evidence); }\n.noma-export-button[data-format="json"] { background: var(--noma-muted); }\n\n/* Controls (interactive artifact blocks) */\n.noma-control {\n  margin: 1em 0;\n  padding: 0.8em 1em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n.noma-control-row {\n  display: grid;\n  grid-template-columns: minmax(9rem, 1fr) minmax(8rem, 2fr);\n  gap: 0.75rem;\n  align-items: center;\n}\n.noma-control-label { font-weight: 650; }\n.noma-control input,\n.noma-control select {\n  width: 100%;\n  accent-color: var(--noma-accent);\n  font: inherit;\n}\n.noma-control input[type="number"],\n.noma-control input[type="text"],\n.noma-control select {\n  border: 1px solid var(--noma-rule);\n  border-radius: 6px;\n  padding: 0.35em 0.5em;\n  background: var(--noma-bg);\n  color: var(--noma-fg);\n}\n.noma-control input[type="checkbox"] {\n  width: auto;\n  justify-self: start;\n}\n.noma-control-value {\n  display: block;\n  margin-top: 0.35rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-mono);\n  font-size: 0.82rem;\n}\n.noma-interactive-disabled {\n  display: inline-block;\n  margin-bottom: 0.5rem;\n  padding: 0.18em 0.55em;\n  border: 1px solid var(--noma-rule);\n  border-radius: 999px;\n  color: var(--noma-muted);\n  background: var(--noma-bg);\n  font-family: var(--noma-font-sans);\n  font-size: 0.72rem;\n  font-weight: 650;\n}\n\n.noma-computed {\n  margin: 1.2em 0;\n  padding: 1em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 4px solid var(--noma-claim);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\n.noma-computed-head {\n  display: flex;\n  gap: 0.8rem;\n  align-items: baseline;\n  flex-wrap: wrap;\n  margin-bottom: 0.45rem;\n}\n.noma-computed-head h3 {\n  margin: 0;\n  font-size: 1rem;\n}\n.noma-computed-value {\n  font-family: var(--noma-font-sans);\n  font-size: 1.75rem;\n  line-height: 1.15;\n  font-weight: 750;\n  color: var(--noma-claim);\n}\n.noma-computed-body {\n  margin-top: 0.75rem;\n}\n.noma-computed-body p {\n  margin-bottom: 0;\n}\n.noma-computed-plot {\n  padding: 1em;\n}\n.noma-computed-canvas {\n  margin-bottom: 0.5rem;\n}\n.noma-computed-table-view {\n  margin: 0.65rem 0 0;\n  font-size: 0.9rem;\n}\n.noma-computed-table-view th:last-child,\n.noma-computed-table-view td:last-child {\n  text-align: right;\n}\n@media (max-width: 720px) {\n  .noma-control-row {\n    grid-template-columns: 1fr;\n  }\n}\n\n.noma-confidence {\n  flex: 1;\n  height: 6px;\n  border-radius: 999px;\n  background: var(--noma-rule);\n  overflow: hidden;\n  max-width: 140px;\n}\n.noma-confidence-bar {\n  height: 100%;\n  background: linear-gradient(90deg, var(--noma-accent), var(--noma-claim));\n}\n\n.noma-meta {\n  margin-top: 0.6em;\n  font-size: 0.85rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n}\n.noma-meta-key {\n  font-weight: 600;\n  color: var(--noma-fg);\n}\n\n/* Grid */\n.noma-grid,\n.noma-columns {\n  display: grid;\n  grid-template-columns: repeat(var(--noma-cols), minmax(0, 1fr));\n  gap: var(--noma-grid-gap);\n  margin: 1.5em 0;\n}\n.noma-grid-auto,\n.noma-columns-auto {\n  grid-template-columns: repeat(auto-fit, minmax(min(var(--noma-grid-min), 100%), 1fr));\n}\n.noma-grid-wide,\n.noma-columns-wide,\n.noma-grid-full,\n.noma-columns-full {\n  position: relative;\n  left: 50%;\n  transform: translateX(-50%);\n}\n.noma-grid-wide,\n.noma-columns-wide {\n  width: min(1180px, calc(100vw - 2rem));\n}\n.noma-grid-full,\n.noma-columns-full {\n  width: min(1440px, calc(100vw - 2rem));\n}\n.noma-grid-compact,\n.noma-columns-compact {\n  --noma-grid-gap: 0.75rem;\n}\n@media (max-width: 720px) {\n  .noma-grid,\n  .noma-columns {\n    grid-template-columns: 1fr;\n    width: auto;\n    left: auto;\n    transform: none;\n  }\n}\n\n/* Card */\narticle.noma-card {\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  padding: 1em 1.1em;\n  box-shadow: var(--noma-shadow);\n}\narticle.noma-card .noma-card-head {\n  display: flex;\n  align-items: center;\n  gap: 0.6em;\n  margin-bottom: 0.4em;\n}\narticle.noma-card h3 {\n  margin: 0;\n  font-size: 1rem;\n  font-family: var(--noma-font-sans);\n}\narticle.noma-card .noma-icon {\n  color: var(--noma-accent);\n  font-size: 0.9em;\n}\narticle.noma-card p:last-child { margin-bottom: 0; }\n\n/* Hero */\nsection.noma-hero {\n  background: linear-gradient(180deg, var(--noma-accent-soft), transparent);\n  padding: 3rem 2rem 2.4rem;\n  border-radius: var(--noma-radius);\n  margin: 0 0 3rem;\n  text-align: center;\n}\nsection.noma-hero h1 { font-size: 2.8rem; margin-top: 0; }\n\na.noma-button {\n  display: inline-block;\n  background: var(--noma-fg);\n  color: var(--noma-bg);\n  padding: 0.7em 1.4em;\n  border-radius: 999px;\n  text-decoration: none;\n  font-family: var(--noma-font-sans);\n  font-weight: 600;\n  font-size: 0.95rem;\n  margin-top: 0.5em;\n}\na.noma-button:hover { background: var(--noma-accent); color: white; }\n\n/* Plot */\nfigure.noma-plot {\n  margin: 1.8em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n}\nfigure.noma-plot .noma-plot-canvas {\n  color: var(--noma-claim);\n  background: linear-gradient(180deg, transparent, var(--noma-claim-soft));\n  border-radius: 6px;\n  padding: 0.6em;\n}\nfigure.noma-plot svg { width: 100%; height: auto; display: block; }\nfigure.noma-plot figcaption {\n  margin-top: 0.6em;\n  font-size: 0.85rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n}\nfigure.noma-plot[data-compact="true"] {\n  padding: 0.65em 0.8em;\n}\nfigure.noma-plot[data-compact="true"] figcaption {\n  margin-top: 0.35em;\n  font-size: 0.78rem;\n}\n\n/* Dataset */\ndetails.noma-dataset {\n  margin: 1.4em 0;\n  padding: 0.6em 1em;\n  background: var(--noma-code-bg);\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\ndetails.noma-dataset pre {\n  background: transparent;\n  padding: 0.6em 0 0;\n}\n\n/* Agent task */\n.noma-agent-task {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-claim-soft);\n  border-left: 3px solid var(--noma-claim);\n  border-radius: var(--noma-radius);\n}\n.noma-agent-task label {\n  display: flex;\n  align-items: center;\n  gap: 0.6em;\n  font-family: var(--noma-font-sans);\n  font-weight: 600;\n  font-size: 0.9rem;\n  margin-bottom: 0.4em;\n}\n\n/* Collaboration metadata */\naside.noma-comment,\naside.noma-review-meta {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid #5a6071;\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\naside.noma-comment {\n  background: #f7f6f1;\n}\n.noma-comment-head,\n.noma-review-meta-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.55em;\n  margin-bottom: 0.4em;\n  font-family: var(--noma-font-sans);\n}\n.noma-comment .noma-tag,\n.noma-review-meta .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: #5a6071;\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: #ecedf2;\n}\n.noma-review-meta.noma-collab-review {\n  border-left-color: var(--noma-accent);\n}\n.noma-review-meta.noma-collab-review .noma-tag {\n  color: var(--noma-accent);\n  background: var(--noma-accent-soft);\n}\n.noma-review-meta.noma-collab-provenance {\n  border-left-color: var(--noma-claim);\n}\n.noma-review-meta.noma-collab-provenance .noma-tag {\n  color: var(--noma-claim);\n  background: var(--noma-claim-soft);\n}\n.noma-review-meta.noma-collab-confidence {\n  border-left-color: var(--noma-evidence);\n}\n.noma-review-meta.noma-collab-confidence .noma-tag {\n  color: var(--noma-evidence);\n  background: var(--noma-evidence-soft);\n}\n.noma-comment-body p:last-child,\n.noma-review-meta-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Memory profile */\naside.noma-memory,\naside.noma-memory-index {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid #5a6071;\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\naside.noma-memory-index {\n  background: #f4f7f8;\n}\n.noma-memory-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.4em;\n  font-family: var(--noma-font-sans);\n}\n.noma-memory .noma-tag,\n.noma-memory-index .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0;\n  text-transform: uppercase;\n  color: #5a6071;\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: #ecedf2;\n}\n.noma-memory h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-memory.noma-memory-user {\n  border-left-color: var(--noma-evidence);\n}\n.noma-memory.noma-memory-user .noma-tag {\n  color: var(--noma-evidence);\n  background: var(--noma-evidence-soft);\n}\n.noma-memory.noma-memory-feedback {\n  border-left-color: var(--noma-accent);\n}\n.noma-memory.noma-memory-feedback .noma-tag {\n  color: var(--noma-accent);\n  background: var(--noma-accent-soft);\n}\n.noma-memory.noma-memory-project {\n  border-left-color: var(--noma-claim);\n}\n.noma-memory.noma-memory-project .noma-tag {\n  color: var(--noma-claim);\n  background: var(--noma-claim-soft);\n}\n.noma-memory.noma-memory-reference {\n  border-left-color: #5a6071;\n}\n.noma-memory.noma-memory-reference .noma-tag {\n  color: #5a6071;\n  background: #ecedf2;\n}\n.noma-memory-body p:last-child,\n.noma-memory-index .noma-memory-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Metrics */\naside.noma-metric {\n  margin: 1.5em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid var(--noma-evidence);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\n.noma-metric-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.25em;\n}\n.noma-metric .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--noma-evidence);\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: var(--noma-evidence-soft);\n}\n.noma-metric h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-metric-value {\n  margin: 0.2em 0 0.25em;\n  color: var(--noma-evidence);\n  font-family: var(--noma-font-sans);\n  font-size: 1.7rem;\n  font-weight: 800;\n  line-height: 1.15;\n}\n.noma-metric-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Technical documentation */\narticle.noma-technical {\n  margin: 1.5em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid var(--noma-claim);\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\narticle.noma-technical .noma-technical-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.35em;\n}\narticle.noma-technical .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--noma-claim);\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: var(--noma-claim-soft);\n}\narticle.noma-technical h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-technical-meta {\n  margin: 0.35em 0 0.65em;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.85rem;\n}\n.noma-technical-body p:last-child {\n  margin-bottom: 0;\n}\npre.noma-technical-code {\n  margin: 0.7em 0 0;\n}\n\n/* Custom directives */\naside.noma-block {\n  margin: 1.5em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid #5a6071;\n  border-radius: var(--noma-radius);\n  box-shadow: var(--noma-shadow);\n}\n.noma-block-head {\n  display: flex;\n  align-items: baseline;\n  flex-wrap: wrap;\n  gap: 0.65em;\n  margin-bottom: 0.35em;\n  font-family: var(--noma-font-sans);\n}\naside.noma-block .noma-tag {\n  display: inline-block;\n  font-family: var(--noma-font-sans);\n  font-size: 0.7rem;\n  font-weight: 700;\n  letter-spacing: 0;\n  text-transform: uppercase;\n  color: #5a6071;\n  padding: 0.2em 0.6em;\n  border-radius: 999px;\n  background: #ecedf2;\n}\naside.noma-block h3 {\n  margin: 0;\n  border: 0;\n  padding: 0;\n  font-size: 1.05rem;\n  line-height: 1.35;\n}\n.noma-block-body p:last-child {\n  margin-bottom: 0;\n}\n\n/* Change requests */\naside.noma-change-request {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: #fff4f0;\n  border: 1px solid #f0c7bd;\n  border-left: 3px solid #c85c4a;\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n}\n.noma-change-request-head {\n  font-size: 0.85rem;\n  color: var(--noma-muted, var(--noma-fg));\n  margin-bottom: 0.45em;\n}\n.noma-change-request-delta {\n  display: flex;\n  align-items: baseline;\n  gap: 0.55em;\n  margin: 0.35em 0 0.55em;\n  line-height: 1.5;\n}\n.noma-change-request del {\n  color: #9a382b;\n  text-decoration-thickness: 0.12em;\n}\n.noma-change-request ins {\n  color: #2f6e42;\n  font-weight: 700;\n  text-decoration: none;\n}\n\n/* State change */\naside.noma-state-change {\n  margin: 1.4em 0;\n  padding: 1em 1.2em;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-left: 3px solid var(--noma-fg);\n  border-radius: var(--noma-radius);\n  font-family: var(--noma-font-sans);\n}\n.noma-state-change-head {\n  font-size: 0.85rem;\n  letter-spacing: 0.02em;\n  color: var(--noma-muted, var(--noma-fg));\n  margin-bottom: 0.4em;\n  display: flex;\n  align-items: center;\n  gap: 0.5em;\n  flex-wrap: wrap;\n}\n.noma-state-change-delta {\n  font-size: 1rem;\n  display: flex;\n  align-items: baseline;\n  gap: 0.6em;\n  margin: 0.3em 0 0.5em;\n  font-variant-numeric: tabular-nums;\n}\n.noma-state-from {\n  text-decoration: line-through;\n  opacity: 0.65;\n}\n.noma-state-to {\n  font-weight: 700;\n}\n.noma-state-arrow {\n  opacity: 0.55;\n  font-size: 0.95em;\n}\n\n/* Tables */\ntable.noma-table {\n  width: 100%;\n  border-collapse: collapse;\n  margin: 1.6em 0;\n  font-family: var(--noma-font-sans);\n  font-size: 0.88rem;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  overflow: hidden;\n  box-shadow: var(--noma-shadow);\n}\ntable.noma-table thead {\n  background: var(--noma-code-bg);\n}\ntable.noma-table th {\n  text-align: left;\n  font-weight: 700;\n  letter-spacing: 0.02em;\n  padding: 0.55em 0.75em;\n  border-bottom: 1px solid var(--noma-rule);\n  color: var(--noma-fg);\n}\ntable.noma-table td {\n  padding: 0.5em 0.75em;\n  border-bottom: 1px solid var(--noma-rule);\n  vertical-align: top;\n}\ntable.noma-table tbody tr:last-child td { border-bottom: 0; }\ntable.noma-table tbody tr:hover { background: rgba(185, 82, 42, 0.04); }\n\n.noma-page-header,\n.noma-page-footer {\n  margin: 1.2rem 0;\n  padding: 0.55rem 0;\n  border-color: var(--noma-rule);\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n.noma-page-header {\n  border-bottom: 1px solid var(--noma-rule);\n}\n.noma-page-footer {\n  border-top: 1px solid var(--noma-rule);\n}\n.noma-page-header p,\n.noma-page-footer p {\n  margin: 0;\n}\n.noma-page-number {\n  display: block;\n  text-align: right;\n}\n\n.noma-toc {\n  margin: 1.6rem 0 2rem;\n  padding: 1rem 1.1rem;\n  border: 1px solid var(--noma-rule);\n  background: var(--noma-card-bg);\n  font-family: var(--noma-font-sans);\n  box-shadow: var(--noma-shadow);\n}\n.noma-toc h2 {\n  margin: 0 0 0.6rem;\n  padding: 0;\n  border: 0;\n  font-size: 1.1rem;\n}\n.noma-toc ol {\n  margin: 0;\n  padding: 0;\n  list-style: none;\n}\n.noma-toc li {\n  margin: 0.15rem 0;\n}\n.noma-toc li[data-level="2"] { margin-left: 1rem; }\n.noma-toc li[data-level="3"] { margin-left: 2rem; }\n.noma-toc li[data-level="4"] { margin-left: 3rem; }\n.noma-toc li[data-level="5"] { margin-left: 4rem; }\n.noma-toc li[data-level="6"] { margin-left: 5rem; }\n\n.noma-footnote,\n.noma-endnote {\n  margin: 1.2rem 0;\n  padding: 0.7rem 0.9rem;\n  border-left: 3px solid var(--noma-rule);\n  background: var(--noma-code-bg);\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9rem;\n}\n.noma-footnote p,\n.noma-endnote p {\n  margin: 0.25rem 0;\n}\n.noma-footnote sup,\n.noma-endnote sup {\n  margin-right: 0.4rem;\n  color: var(--noma-accent);\n  font-weight: 700;\n}\n\n.noma-bibliography {\n  margin: 2rem 0;\n  padding-top: 0.8rem;\n  border-top: 1px solid var(--noma-rule);\n}\n.noma-bibliography h2 {\n  margin-top: 0;\n}\n.noma-bibliography ol {\n  padding-left: 1.4rem;\n}\n.noma-citation-meta {\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 0.9em;\n}\n\n.noma-pagebreak {\n  margin: 2rem 0;\n  border: 0;\n  border-top: 1px dashed var(--noma-rule);\n}\n\n/* Print */\n@media print {\n  @page { margin: 20mm 18mm; }\n  html, body { background: white; font-size: 11pt; }\n  main.noma-doc { margin: 0 auto; padding: 0; max-width: 100%; }\n  section.noma-hero { background: none; border: 1px solid var(--noma-rule); }\n  a { color: var(--noma-fg); }\n  pre, article.noma-card, article.noma-technical, aside.noma-block, .noma-computed, figure.noma-plot, figure.noma-plotly-wrap, figure.noma-diagram-wrap, aside.noma-research, aside.noma-comment, aside.noma-review-meta, aside.noma-memory, aside.noma-memory-index, aside.noma-metric, aside.noma-change-request, aside.noma-footnote, aside.noma-endnote, nav.noma-toc, header.noma-page-header, footer.noma-page-footer, details.noma-dataset, table.noma-table {\n    box-shadow: none;\n    page-break-inside: avoid;\n    break-inside: avoid;\n  }\n  .noma-computed, figure.noma-plot, figure.noma-plotly-wrap, figure.noma-diagram-wrap {\n    background: white;\n  }\n  table.noma-table {\n    font-size: 9.5pt;\n    box-shadow: none;\n  }\n  table.noma-table th,\n  table.noma-table td {\n    padding: 0.35em 0.55em;\n  }\n  h1, h2, h3 {\n    page-break-after: avoid;\n    break-after: avoid;\n  }\n  .noma-pagebreak {\n    margin: 0;\n    border: 0;\n    height: 0;\n    page-break-after: always;\n    break-after: page;\n  }\n}\n\n/* v0.4 \u2014 alias anchors (offset for sticky-headed pages) */\na.noma-alias {\n  display: block;\n  position: relative;\n  top: -1.2em;\n  visibility: hidden;\n  height: 0;\n}\n\n/* v0.4 \u2014 multi-page site nav (rendered above main when --to site) */\nnav.noma-site-nav {\n  max-width: 1040px;\n  margin: 1.5rem auto 0;\n  padding: 0 2rem;\n  display: flex;\n  align-items: baseline;\n  gap: 1.5rem;\n  flex-wrap: wrap;\n  font-size: 0.85rem;\n  color: var(--noma-muted);\n}\nnav.noma-site-nav a.noma-site-home {\n  font-weight: 600;\n  color: var(--noma-fg);\n  text-decoration: none;\n  border-right: 1px solid var(--noma-rule);\n  padding-right: 1.25rem;\n}\nnav.noma-site-nav ol {\n  list-style: none;\n  padding: 0;\n  margin: 0;\n  display: flex;\n  gap: 1.25rem;\n  flex-wrap: wrap;\n  counter-reset: chap;\n}\nnav.noma-site-nav li {\n  counter-increment: chap;\n}\nnav.noma-site-nav li::before {\n  content: counter(chap, decimal-leading-zero) " \xB7 ";\n  color: var(--noma-rule);\n  font-variant-numeric: tabular-nums;\n}\nnav.noma-site-nav a {\n  color: var(--noma-muted);\n  text-decoration: none;\n}\nnav.noma-site-nav a:hover { color: var(--noma-accent); }\nnav.noma-site-nav .noma-nav-current span {\n  color: var(--noma-fg);\n  font-weight: 500;\n}\n\na.noma-ref.noma-xchapter::after {\n  content: " \u2197";\n  font-size: 0.85em;\n  color: var(--noma-muted);\n}\n\nmain.noma-site-index {\n  padding-top: 3rem;\n}\nheader.noma-site-header h1 {\n  font-size: 2.4rem;\n  margin-bottom: 0.25rem;\n}\nheader.noma-site-header .noma-site-author {\n  color: var(--noma-muted);\n  margin: 0 0 2rem;\n}\nol.noma-site-toc {\n  list-style: none;\n  padding: 0;\n  margin: 2rem 0;\n  display: grid;\n  gap: 0.6rem;\n  counter-reset: toc;\n}\nol.noma-site-toc li {\n  counter-increment: toc;\n}\na.noma-site-chapter {\n  display: block;\n  padding: 1.1rem 1.4rem;\n  background: var(--noma-card-bg);\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  text-decoration: none;\n  color: inherit;\n  transition: border-color 120ms ease, transform 120ms ease;\n}\na.noma-site-chapter:hover {\n  border-color: var(--noma-accent);\n  transform: translateY(-1px);\n}\na.noma-site-chapter::before {\n  content: counter(toc, decimal-leading-zero);\n  display: block;\n  font-size: 0.75rem;\n  font-variant-numeric: tabular-nums;\n  color: var(--noma-muted);\n  margin-bottom: 0.25rem;\n}\n.noma-site-chapter-title {\n  display: block;\n  font-weight: 600;\n  font-size: 1.1rem;\n}\n.noma-site-chapter-summary {\n  display: block;\n  color: var(--noma-muted);\n  margin-top: 0.4rem;\n  font-size: 0.93rem;\n}\n.noma-site-description {\n  max-width: 48rem;\n  color: var(--noma-muted);\n  font-family: var(--noma-font-sans);\n  font-size: 1.02rem;\n}\n.noma-site-chapter-tags,\n.noma-space-tags {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 0.35rem;\n  margin-top: 0.6rem;\n}\n.noma-site-chapter-tags span,\n.noma-space-tags span {\n  border: 1px solid var(--noma-rule);\n  border-radius: 999px;\n  padding: 0.12rem 0.45rem;\n  color: var(--noma-muted);\n  background: var(--noma-bg);\n  font-family: var(--noma-font-sans);\n  font-size: 0.72rem;\n}\n\n/* Space renderer \u2014 source-controlled documentation/wiki surface */\nbody.noma-space-body {\n  background: linear-gradient(180deg, #f7f5ef 0, var(--noma-bg) 16rem);\n}\n.noma-space-shell {\n  display: grid;\n  grid-template-columns: minmax(15rem, 18rem) minmax(0, 1fr);\n  min-height: 100vh;\n}\n.noma-space-sidebar {\n  position: sticky;\n  top: 0;\n  height: 100vh;\n  overflow: auto;\n  border-right: 1px solid var(--noma-rule);\n  background: rgba(255, 255, 255, 0.68);\n  padding: 1rem;\n  font-family: var(--noma-font-sans);\n}\n.noma-space-home {\n  display: block;\n  margin-bottom: 0.45rem;\n  color: var(--noma-fg);\n  font-weight: 800;\n  text-decoration: none;\n}\n.noma-space-description,\n.noma-space-search-disabled {\n  margin: 0 0 1rem;\n  color: var(--noma-muted);\n  font-size: 0.82rem;\n  line-height: 1.38;\n}\n.noma-space-search {\n  display: grid;\n  gap: 0.35rem;\n  margin: 0.9rem 0 0.75rem;\n  color: var(--noma-muted);\n  font-size: 0.74rem;\n  font-weight: 750;\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n}\n.noma-space-search input {\n  width: 100%;\n  border: 1px solid var(--noma-rule);\n  border-radius: 7px;\n  padding: 0.5rem 0.6rem;\n  background: var(--noma-card-bg);\n  color: var(--noma-fg);\n  font: 500 0.88rem var(--noma-font-sans);\n  text-transform: none;\n  letter-spacing: 0;\n}\n.noma-space-search-results {\n  display: grid;\n  gap: 0.4rem;\n  margin: 0 0 0.85rem;\n  padding: 0.45rem;\n  border: 1px solid var(--noma-rule);\n  border-radius: 8px;\n  background: var(--noma-card-bg);\n  box-shadow: var(--noma-shadow);\n}\n.noma-space-search-results a {\n  display: grid;\n  gap: 0.1rem;\n  padding: 0.45rem 0.5rem;\n  border-radius: 6px;\n  color: var(--noma-fg);\n  text-decoration: none;\n}\n.noma-space-search-results a:hover {\n  background: var(--noma-code-bg);\n}\n.noma-space-search-results small {\n  color: var(--noma-muted);\n  font-size: 0.76rem;\n}\n.noma-space-search-results em {\n  display: flex;\n  gap: 0.25rem;\n  flex-wrap: wrap;\n  font-style: normal;\n}\n.noma-space-search-results em span {\n  color: var(--noma-accent);\n  font-size: 0.68rem;\n}\n.noma-space-search-results p {\n  margin: 0;\n  color: var(--noma-muted);\n  font-size: 0.82rem;\n}\n.noma-space-sidebar nav.noma-site-nav {\n  max-width: none;\n  margin: 0;\n  padding: 0;\n  display: block;\n}\n.noma-space-sidebar nav.noma-site-nav ol {\n  display: grid;\n  gap: 0.18rem;\n  list-style: none;\n  margin: 0;\n  padding: 0;\n  counter-reset: none;\n}\n.noma-space-sidebar nav.noma-site-nav li {\n  padding-left: calc(var(--depth, 0) * 0.85rem);\n}\n.noma-space-sidebar nav.noma-site-nav li::before {\n  content: "";\n}\n.noma-space-sidebar nav.noma-site-nav a,\n.noma-space-sidebar nav.noma-site-nav span {\n  display: block;\n  border-radius: 6px;\n  padding: 0.38rem 0.5rem;\n  color: var(--noma-muted);\n  text-decoration: none;\n  font-size: 0.88rem;\n  line-height: 1.25;\n}\n.noma-space-sidebar nav.noma-site-nav a:hover {\n  background: var(--noma-code-bg);\n  color: var(--noma-fg);\n}\n.noma-space-sidebar nav.noma-site-nav .noma-nav-current span {\n  background: var(--noma-accent-soft);\n  color: var(--noma-accent);\n  font-weight: 760;\n}\n.noma-space-sidebar nav.noma-site-nav small {\n  display: block;\n  padding: 0 0.5rem 0.32rem;\n  color: var(--noma-muted);\n  font-size: 0.68rem;\n}\n.noma-space-main {\n  min-width: 0;\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(15rem, 18rem);\n  grid-template-rows: auto 1fr;\n  gap: 1rem;\n  padding: 1rem;\n}\n.noma-space-topbar {\n  grid-column: 1 / -1;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 1rem;\n  min-width: 0;\n  padding: 0.5rem 0.2rem;\n  font-family: var(--noma-font-sans);\n}\n.noma-space-breadcrumbs {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 0.35rem;\n  min-width: 0;\n  color: var(--noma-muted);\n  font-size: 0.83rem;\n}\n.noma-space-breadcrumbs a,\n.noma-space-breadcrumbs span {\n  color: inherit;\n  text-decoration: none;\n}\n.noma-space-breadcrumbs span:last-child {\n  color: var(--noma-fg);\n  font-weight: 700;\n}\n.noma-space-breadcrumbs a::after,\n.noma-space-breadcrumbs span::after {\n  content: "/";\n  margin-left: 0.35rem;\n  color: var(--noma-rule);\n}\n.noma-space-breadcrumbs span:last-child::after {\n  content: "";\n  margin: 0;\n}\n.noma-space-actions {\n  display: flex;\n  align-items: center;\n  gap: 0.4rem;\n}\n.noma-space-actions button {\n  border: 1px solid var(--noma-rule);\n  border-radius: 7px;\n  background: var(--noma-card-bg);\n  color: var(--noma-muted);\n  padding: 0.38rem 0.6rem;\n  font: 700 0.78rem var(--noma-font-sans);\n  cursor: pointer;\n}\n.noma-space-actions button:hover {\n  border-color: var(--noma-accent);\n  color: var(--noma-accent);\n}\nbody.noma-space-body main.noma-doc {\n  min-width: 0;\n  max-width: none;\n  margin: 0;\n  padding: 2rem min(4vw, 2.5rem) 5rem;\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  background: rgba(255, 255, 255, 0.78);\n  box-shadow: var(--noma-shadow);\n}\n.noma-space-inspector {\n  min-width: 0;\n  align-self: start;\n  position: sticky;\n  top: 1rem;\n  display: grid;\n  gap: 0.75rem;\n  font-family: var(--noma-font-sans);\n}\n.noma-space-inspector section {\n  border: 1px solid var(--noma-rule);\n  border-radius: var(--noma-radius);\n  padding: 0.85rem;\n  background: rgba(255, 255, 255, 0.72);\n  box-shadow: var(--noma-shadow);\n}\n.noma-space-inspector h2 {\n  margin: 0 0 0.55rem;\n  padding: 0;\n  border: 0;\n  color: var(--noma-muted);\n  font-size: 0.76rem;\n  letter-spacing: 0.05em;\n  text-transform: uppercase;\n}\n.noma-space-inspector p {\n  display: flex;\n  justify-content: space-between;\n  gap: 0.6rem;\n  margin: 0.3rem 0;\n  color: var(--noma-muted);\n  font-size: 0.82rem;\n}\n.noma-space-inspector strong {\n  color: var(--noma-fg);\n  overflow-wrap: anywhere;\n}\n.noma-space-inspector ul {\n  margin: 0;\n  padding-left: 1rem;\n}\n.noma-space-inspector li {\n  margin: 0.25rem 0;\n  font-size: 0.84rem;\n}\n.noma-space-empty {\n  display: block !important;\n  color: var(--noma-muted);\n}\n.noma-space-stats {\n  display: flex;\n  gap: 0.5rem;\n  flex-wrap: wrap;\n  margin: 1rem 0 0;\n  font-family: var(--noma-font-sans);\n}\n.noma-space-stats span {\n  border: 1px solid var(--noma-rule);\n  border-radius: 999px;\n  background: var(--noma-card-bg);\n  color: var(--noma-muted);\n  padding: 0.2rem 0.6rem;\n  font-size: 0.8rem;\n  font-weight: 700;\n}\nbody.noma-space-body ol.noma-site-toc {\n  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));\n}\n@media (max-width: 1100px) {\n  .noma-space-main {\n    grid-template-columns: minmax(0, 1fr);\n  }\n  .noma-space-inspector {\n    position: static;\n    grid-template-columns: repeat(3, minmax(0, 1fr));\n  }\n}\n@media (max-width: 780px) {\n  .noma-space-shell {\n    grid-template-columns: 1fr;\n  }\n  .noma-space-sidebar {\n    position: static;\n    height: auto;\n    border-right: 0;\n    border-bottom: 1px solid var(--noma-rule);\n  }\n  .noma-space-main {\n    padding: 0.75rem;\n  }\n  .noma-space-topbar {\n    align-items: flex-start;\n    flex-direction: column;\n  }\n  body.noma-space-body main.noma-doc {\n    padding: 1.25rem 1rem 3rem;\n  }\n  .noma-space-inspector {\n    grid-template-columns: 1fr;\n  }\n}\n\n/* v0.4 \u2014 math (KaTeX is loaded from CDN; we just style block layout) */\n.noma-math-display {\n  margin: 1.4em auto;\n  text-align: center;\n  overflow-x: auto;\n}\n.noma-math-inline {\n  display: inline;\n}\n';

  // web/cloud-app.ts
  var userStorageKey = "noma.cloud.user.v1";
  var activeSiteStorageKey = "noma.cloud.activeSite.v1";
  var activeDocumentStorageKey = "noma.cloud.activeDocument.v1";
  var viewModeStorageKey = "noma.cloud.viewMode.v1";
  var panelsOpenStorageKey = "noma.cloud.panelsOpen.v1";
  var splitSourceRatioStorageKey = "noma.cloud.splitSourceRatio.v1";
  var previewPaperWidthStorageKey = "noma.cloud.previewPaperWidth.v1";
  var themeStorageKey = "noma.cloud.theme.v1";
  var query = new URLSearchParams(window.location.search);
  var cloudUserNameInput = requireElement("cloudUserName");
  var newUserButton = requireElement("newUserButton");
  var copyUserIdButton = requireElement("copyUserIdButton");
  var copyUserTokenButton = requireElement("copyUserTokenButton");
  var themeToggleButton = requireElement("themeToggleButton");
  var cloudStatus = requireElement("cloudStatus");
  var siteTitleInput = requireElement("siteTitleInput");
  var newSpaceButton = requireElement("newSpaceButton");
  var saveSpaceButton = requireElement("saveSpaceButton");
  var siteList = requireElement("siteList");
  var newPageButton = requireElement("newPageButton");
  var newFolderButton = requireElement("newFolderButton");
  var pageList = requireElement("pageList");
  var pageTitleInput = requireElement("pageTitleInput");
  var roleBadge = requireElement("roleBadge");
  var dirtyBadge = requireElement("dirtyBadge");
  var updatedText = requireElement("updatedText");
  var sourceViewButton = requireElement("sourceViewButton");
  var splitViewButton = requireElement("splitViewButton");
  var previewViewButton = requireElement("previewViewButton");
  var togglePanelsButton = requireElement("togglePanelsButton");
  var savePageButton = requireElement("savePageButton");
  var copyPageLinkButton = requireElement("copyPageLinkButton");
  var copyArtifactLinkButton = requireElement("copyArtifactLinkButton");
  var copySiteLinkButton = requireElement("copySiteLinkButton");
  var openPublishedSiteButton = requireElement("openPublishedSiteButton");
  var documentGrid = requireElement("documentGrid");
  var splitResizeHandle = requireElement("splitResizeHandle");
  var sourceInput = requireElement("sourceInput");
  var previewFrame = requireElement("previewFrame");
  var shareRoleSelect = requireElement("shareRoleSelect");
  var inviteUserIdInput = requireElement("inviteUserIdInput");
  var inviteRoleSelect = requireElement("inviteRoleSelect");
  var inviteUserButton = requireElement("inviteUserButton");
  var shareStatus = requireElement("shareStatus");
  var patchInput = requireElement("patchInput");
  var applyPatchButton = requireElement("applyPatchButton");
  var copyLlmButton = requireElement("copyLlmButton");
  var agentStatus = requireElement("agentStatus");
  var diagnosticsSummary = requireElement("diagnosticsSummary");
  var diagnosticsList = requireElement("diagnosticsList");
  var outlineList = requireElement("outlineList");
  var wikiSummary = requireElement("wikiSummary");
  var wikiLinksList = requireElement("wikiLinksList");
  var cloudAvailable = false;
  var busy = false;
  var cloudUser = readCloudUser();
  var shareToken = readShareToken();
  var sites = [];
  var currentSite;
  var pages = [];
  var currentPage;
  var activeFolder = "";
  var dirty = false;
  var renderTimer;
  var renderState = emptyRenderState();
  var viewMode = readViewMode();
  var panelsOpen = readPanelsOpen();
  var splitSourceRatio = readSplitSourceRatio();
  var previewPaperWidth = readPreviewPaperWidth();
  var themeMode = readThemeMode();
  var pendingPreviewFocusLine;
  applyThemeMode();
  cloudUserNameInput.value = cloudUser?.name ?? "Noma collaborator";
  bindEvents();
  renderChrome();
  void initializeCloud();
  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id}`);
    return element;
  }
  function bindEvents() {
    document.addEventListener("click", () => closeContextMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeContextMenu();
    });
    window.addEventListener("resize", () => closeContextMenu());
    newUserButton.addEventListener("click", () => {
      void createCloudUser();
    });
    copyUserIdButton.addEventListener("click", () => {
      if (cloudUser) void copyText(cloudUser.id, "Copied user ID");
    });
    copyUserTokenButton.addEventListener("click", () => {
      if (cloudUser) void copyText(cloudUser.token, "Copied user token");
    });
    themeToggleButton.addEventListener("click", () => {
      themeMode = themeMode === "dark" ? "light" : "dark";
      localStorage.setItem(themeStorageKey, themeMode);
      applyThemeMode();
      renderChrome();
      renderCurrent();
    });
    newSpaceButton.addEventListener("click", () => {
      void createStarterWorkspace(promptName("Space name", "Research Workspace"));
    });
    saveSpaceButton.addEventListener("click", () => {
      void saveCurrentSite();
    });
    newPageButton.addEventListener("click", () => {
      void createPage();
    });
    newFolderButton.addEventListener("click", () => {
      void createFolder();
    });
    savePageButton.addEventListener("click", () => {
      void saveCurrentPage();
    });
    copyPageLinkButton.addEventListener("click", () => {
      void copyPageLink();
    });
    copyArtifactLinkButton.addEventListener("click", () => {
      void copyArtifactLink();
    });
    copySiteLinkButton.addEventListener("click", () => {
      void copySiteLink();
    });
    openPublishedSiteButton.addEventListener("click", () => {
      void openPublishedSite();
    });
    inviteUserButton.addEventListener("click", () => {
      void inviteCollaborator();
    });
    applyPatchButton.addEventListener("click", () => {
      void applyAgentPatch();
    });
    copyLlmButton.addEventListener("click", () => {
      void copyLlmContext();
    });
    for (const button of [sourceViewButton, splitViewButton, previewViewButton]) {
      button.addEventListener("click", () => {
        const mode = button.dataset.viewMode;
        setViewMode(mode === "source" || mode === "preview" ? mode : "split");
      });
    }
    togglePanelsButton.addEventListener("click", () => {
      panelsOpen = !panelsOpen;
      localStorage.setItem(panelsOpenStorageKey, panelsOpen ? "true" : "false");
      renderChrome();
    });
    sourceInput.addEventListener("input", () => {
      markDirty();
      syncTitleFromSource();
      scheduleRender();
    });
    pageTitleInput.addEventListener("input", () => {
      const nextTitle = pageTitleInput.value.trim() || "Untitled Page";
      sourceInput.value = replaceFirstHeading(sourceInput.value, nextTitle);
      if (currentPage) currentPage = { ...currentPage, title: nextTitle, source: sourceInput.value };
      markDirty();
      scheduleRender();
    });
    sourceInput.addEventListener("keydown", (event) => {
      if (!event.metaKey && !event.ctrlKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveCurrentPage();
    });
    sourceInput.addEventListener("contextmenu", (event) => showSourceContextMenu(event));
    splitResizeHandle.addEventListener("pointerdown", (event) => startSplitResize(event));
    splitResizeHandle.addEventListener("keydown", (event) => handleSplitResizeKeydown(event));
    previewFrame.addEventListener("load", () => installPreviewEditing());
  }
  async function initializeCloud() {
    setBusy(true, "Connecting to cloud", "warning");
    try {
      const status = await fetchCloudJson("/api/status");
      cloudAvailable = true;
      validateStoredCloudUser(status.user);
      if (!cloudUser && !shareToken) {
        clearWorkspaceState();
        setCloudStatus("Register with an invitation code or log in with an existing user token", "warning");
        return;
      }
      const requestedSite = readCloudId(query.get("site")) ?? readCloudId(localStorage.getItem(activeSiteStorageKey));
      const requestedDoc = readCloudId(query.get("doc")) ?? readCloudId(localStorage.getItem(activeDocumentStorageKey));
      if (requestedSite) {
        await refreshSites({ silent: true });
        await loadSite(requestedSite, requestedDoc);
      } else if (requestedDoc) {
        await refreshSites({ silent: true });
        await loadStandaloneDocument(requestedDoc);
      } else {
        await refreshSites({ silent: true });
        const firstSite = sites[0];
        if (firstSite) await loadSite(firstSite.id);
        else await createStarterWorkspace("Research Workspace");
      }
      setCloudStatus("Ready", "ok");
    } catch (error) {
      cloudAvailable = false;
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  function validateStoredCloudUser(statusUser) {
    if (!cloudUser) return;
    if (statusUser && statusUser.id === cloudUser.id) {
      cloudUser = {
        id: statusUser.id,
        name: statusUser.name,
        token: cloudUser.token,
        tokenPreview: statusUser.tokenPreview ?? cloudUser.tokenPreview
      };
      localStorage.setItem(userStorageKey, JSON.stringify(cloudUser));
      cloudUserNameInput.value = cloudUser.name;
      return;
    }
    cloudUser = void 0;
    localStorage.removeItem(userStorageKey);
    localStorage.removeItem(activeSiteStorageKey);
    localStorage.removeItem(activeDocumentStorageKey);
  }
  function clearWorkspaceState() {
    sites = [];
    currentSite = void 0;
    activeFolder = "";
    pages = [];
    setCurrentPage(void 0);
    siteTitleInput.value = "Research Workspace";
  }
  async function refreshSites(options = {}) {
    if (!cloudUser) return;
    if (!options.silent) setBusy(true, "Loading spaces", "warning");
    try {
      const response = await fetchCloudJson("/api/sites");
      sites = response.sites.map(normalizeSite);
    } finally {
      if (!options.silent) setBusy(false);
      renderNavigation();
    }
  }
  async function loadSite(siteId, preferredDocumentId) {
    if (!confirmDiscardDirty()) return;
    setBusy(true, "Opening space", "warning");
    try {
      const site = await fetchCloudJson(`/api/sites/${encodeURIComponent(siteId)}?include=documents`);
      currentSite = normalizeSite(site);
      pages = site.documents ?? [];
      siteTitleInput.value = currentSite.title;
      localStorage.setItem(activeSiteStorageKey, currentSite.id);
      const selected = preferredDocumentId ? pages.find((page) => page.id === preferredDocumentId) : void 0;
      setCurrentPage(selected ?? pages[0]);
      updateAddress();
      if (cloudUser) await refreshSites({ silent: true });
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function loadStandaloneDocument(documentId) {
    if (!confirmDiscardDirty()) return;
    setBusy(true, "Opening page", "warning");
    try {
      const page = await fetchCloudJson(`/api/documents/${encodeURIComponent(documentId)}`);
      currentSite = void 0;
      activeFolder = "";
      pages = [page];
      siteTitleInput.value = "Standalone Page";
      setCurrentPage(page);
      updateAddress();
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function createStarterWorkspace(name) {
    if (!cloudAvailable) return;
    if (!cloudUser) {
      setCloudStatus("Register a user before creating workspaces", "error");
      return;
    }
    if (!confirmDiscardDirty()) return;
    setBusy(true, "Creating space", "warning");
    try {
      const page = await fetchCloudJson("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Research Paper Draft",
          source: starterPage("Research Paper Draft", name)
        })
      });
      const site = await fetchCloudJson("/api/sites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: name,
          documentIds: [page.id],
          folders: ["Drafts"],
          pageFolders: { [page.id]: "Drafts" }
        })
      });
      await refreshSites({ silent: true });
      await loadSite(site.id, page.id);
      setCloudStatus("Created space", "ok");
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function createPage(folder = activeFolder) {
    if (!currentSite) {
      await createStarterWorkspace(promptName("Space name", "Research Workspace"));
      return;
    }
    if (!cloudUser) {
      setCloudStatus("A user token is required to create pages", "error");
      return;
    }
    if (!confirmDiscardDirty()) return;
    const normalizedFolder = normalizeFolderName(folder);
    const title = promptName(normalizedFolder ? `Page title in ${normalizedFolder}` : "Page title", "Untitled Page");
    setBusy(true, "Creating page", "warning");
    try {
      const page = await fetchCloudJson(`/api/sites/${encodeURIComponent(currentSite.id)}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          source: starterPage(title, currentSite.title),
          folder: normalizedFolder
        })
      });
      pages = [...pages, page];
      const documentIds = [...currentSite.documentIds, page.id];
      const pageFolders = normalizedPageFolders({ ...currentSite.pageFolders, ...normalizedFolder ? { [page.id]: normalizedFolder } : {} }, documentIds);
      currentSite = {
        ...currentSite,
        documentIds,
        folders: normalizeFolders([...currentSite.folders ?? [], normalizedFolder, ...Object.values(pageFolders)]),
        pageFolders,
        documents: pages
      };
      activeFolder = normalizedFolder;
      setCurrentPage(page);
      await refreshSites({ silent: true });
      updateAddress();
      setCloudStatus("Created page", "ok");
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function createFolder() {
    if (!currentSite || !canEditSite()) return;
    const folder = promptFolder("Folder name", "Research Notes");
    if (folder === void 0) return;
    if (!folder) {
      setCloudStatus("Folder name required", "error");
      return;
    }
    if (siteFolders(currentSite).some((item) => sameFolder(item, folder))) {
      activeFolder = folder;
      setCloudStatus("Selected folder", "ok");
      renderChrome();
      return;
    }
    currentSite = {
      ...currentSite,
      folders: normalizeFolders([...currentSite.folders ?? [], folder]),
      pageFolders: normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds),
      documents: pages
    };
    activeFolder = folder;
    await saveSiteStructure("Created folder");
  }
  async function renameFolder(folder) {
    if (!currentSite || !canEditSite()) return;
    const currentFolder = normalizeFolderName(folder);
    if (!currentFolder) return;
    const nextFolder = promptFolder("Rename folder", currentFolder);
    if (nextFolder === void 0 || !nextFolder || sameFolder(currentFolder, nextFolder)) return;
    const pageFolders = normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds);
    for (const [pageId, pageFolder2] of Object.entries(pageFolders)) {
      if (sameFolder(pageFolder2, currentFolder)) pageFolders[pageId] = nextFolder;
    }
    currentSite = {
      ...currentSite,
      folders: normalizeFolders((currentSite.folders ?? []).map((item) => sameFolder(item, currentFolder) ? nextFolder : item)),
      pageFolders,
      documents: pages
    };
    activeFolder = nextFolder;
    await saveSiteStructure("Renamed folder");
  }
  async function deleteFolder(folder) {
    if (!currentSite || !canEditSite()) return;
    const currentFolder = normalizeFolderName(folder);
    if (!currentFolder) return;
    const pagesInFolder = pages.filter((page) => sameFolder(pageFolder(page.id), currentFolder)).length;
    const message = pagesInFolder > 0 ? `Delete folder "${currentFolder}"? ${pagesInFolder} page${pagesInFolder === 1 ? "" : "s"} will move to Pages.` : `Delete folder "${currentFolder}"?`;
    if (!window.confirm(message)) return;
    const pageFolders = normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds);
    for (const [pageId, pageFolder2] of Object.entries(pageFolders)) {
      if (sameFolder(pageFolder2, currentFolder)) delete pageFolders[pageId];
    }
    currentSite = {
      ...currentSite,
      folders: normalizeFolders((currentSite.folders ?? []).filter((item) => !sameFolder(item, currentFolder))),
      pageFolders,
      documents: pages
    };
    if (sameFolder(activeFolder, currentFolder)) activeFolder = "";
    await saveSiteStructure("Deleted folder");
  }
  async function movePage(pageId) {
    if (!currentSite || !canEditSite()) return;
    const page = pages.find((item) => item.id === pageId);
    if (!page) return;
    const folder = promptFolder(`Move "${page.title}" to folder`, pageFolder(page.id));
    if (folder === void 0) return;
    await movePageToFolder(pageId, folder);
  }
  async function movePageToFolder(pageId, folder) {
    if (!currentSite || !canEditSite()) return;
    const page = pages.find((item) => item.id === pageId);
    if (!page) return;
    const pageFolders = normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds);
    if (folder) pageFolders[page.id] = folder;
    else delete pageFolders[page.id];
    currentSite = {
      ...currentSite,
      folders: normalizeFolders([...currentSite.folders ?? [], folder, ...Object.values(pageFolders)]),
      pageFolders,
      documents: pages
    };
    activeFolder = folder;
    await saveSiteStructure(folder ? `Moved page to ${folder}` : "Moved page to Pages");
  }
  async function saveSiteStructure(status) {
    if (!currentSite || !canEditSite()) return;
    setBusy(true, "Saving folders", "warning");
    try {
      const saved = await fetchCloudJson(`/api/sites/${encodeURIComponent(currentSite.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: siteTitleInput.value.trim() || currentSite.title,
          documentIds: currentSite.documentIds,
          folders: siteFolders(currentSite),
          pageFolders: normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds)
        })
      });
      currentSite = { ...normalizeSite(saved), documents: pages };
      sites = sites.map((site) => site.id === saved.id ? normalizeSite(saved) : site);
      setCloudStatus(status, "ok");
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function saveCurrentPage() {
    if (!currentPage || !canEditPage()) return;
    if (renderState.error) {
      setCloudStatus("Fix the render error before saving", "error");
      return;
    }
    setBusy(true, "Saving page", "warning");
    try {
      const endpoint = currentSite?.documentIds.includes(currentPage.id) ? `/api/sites/${encodeURIComponent(currentSite.id)}/documents/${encodeURIComponent(currentPage.id)}` : `/api/documents/${encodeURIComponent(currentPage.id)}`;
      const saved = await fetchCloudJson(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value),
          source: sourceInput.value
        })
      });
      replacePage(saved);
      currentPage = saved;
      dirty = false;
      syncTitleFromSource();
      setCloudStatus("Saved page", "ok");
      updateAddress();
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function saveCurrentSite() {
    if (!currentSite || !canEditSite()) return;
    setBusy(true, "Saving space", "warning");
    try {
      const saved = await fetchCloudJson(`/api/sites/${encodeURIComponent(currentSite.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: siteTitleInput.value.trim() || currentSite.title,
          documentIds: currentSite.documentIds,
          folders: siteFolders(currentSite),
          pageFolders: normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds)
        })
      });
      currentSite = { ...normalizeSite(saved), documents: pages };
      sites = sites.map((site) => site.id === saved.id ? saved : site);
      setCloudStatus("Saved space", "ok");
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function copyPageLink() {
    if (!currentPage) return;
    await ensureSavedBeforeShare();
    const role = selectedShareRole();
    const share = await createShare(`/api/documents/${encodeURIComponent(currentPage.id)}/shares`, role, "Noma Cloud page");
    await copyText(cloudAppDocumentUrl(currentPage.id, share.token), `Copied ${role} page link`);
  }
  async function copyArtifactLink() {
    if (!currentPage) return;
    await ensureSavedBeforeShare();
    const share = await createShare(`/api/documents/${encodeURIComponent(currentPage.id)}/shares`, "viewer", "Noma rendered artifact");
    await copyText(absoluteUrl(`/d/${currentPage.id}?share=${encodeURIComponent(share.token)}`), "Copied artifact link");
  }
  async function copySiteLink() {
    if (!currentSite) return;
    await ensureSavedBeforeShare();
    const role = selectedShareRole();
    const share = await createShare(`/api/sites/${encodeURIComponent(currentSite.id)}/shares`, role, "Noma Cloud space");
    await copyText(cloudAppSiteUrl(currentSite.id, share.token), `Copied ${role} space link`);
  }
  async function openPublishedSite() {
    if (!currentSite) return;
    await ensureSavedBeforeShare();
    const share = await createShare(`/api/sites/${encodeURIComponent(currentSite.id)}/shares`, "viewer", "Published site");
    window.open(absoluteUrl(`/s/${currentSite.id}?share=${encodeURIComponent(share.token)}`), "_blank", "noopener");
  }
  async function inviteCollaborator() {
    const userId = inviteUserIdInput.value.trim();
    if (!readCloudId(userId)) {
      setPanelStatus(shareStatus, "Enter a valid user ID", "error");
      return;
    }
    const role = selectedInviteRole();
    if (!currentSite && !currentPage) return;
    setBusy(true, "Inviting collaborator", "warning");
    try {
      if (currentSite) {
        await postCollaborator(`/api/sites/${encodeURIComponent(currentSite.id)}/collaborators`, userId, role);
        for (const page of pages) {
          await postCollaborator(`/api/documents/${encodeURIComponent(page.id)}/collaborators`, userId, role);
        }
      } else if (currentPage) {
        await postCollaborator(`/api/documents/${encodeURIComponent(currentPage.id)}/collaborators`, userId, role);
      }
      inviteUserIdInput.value = "";
      setPanelStatus(shareStatus, `Invited ${userId} as ${role}`, "ok");
      setCloudStatus("Invited collaborator", "ok");
    } catch (error) {
      setPanelStatus(shareStatus, errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function postCollaborator(url, userId, role) {
    await fetchCloudJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, role })
    });
  }
  async function applyAgentPatch() {
    try {
      const ops = parsePatchOps(patchInput.value);
      const nextSource = patchSource(sourceInput.value, ops);
      const nextDoc = parse(nextSource, { filename: `${currentPage?.id ?? "draft"}.noma` });
      const nextDiagnostics = validate(nextDoc);
      const errors = nextDiagnostics.filter((item) => item.severity === "error");
      if (errors.length > 0) {
        throw new Error(`Patch produced ${errors.length} validation error${errors.length === 1 ? "" : "s"}`);
      }
      sourceInput.value = nextSource;
      markDirty();
      syncTitleFromSource();
      renderCurrent();
      setPanelStatus(agentStatus, `Applied ${ops.length} patch op${ops.length === 1 ? "" : "s"}`, "ok");
      setCloudStatus("Applied patch", "ok");
    } catch (error) {
      setPanelStatus(agentStatus, errorMessage(error), "error");
    }
  }
  async function copyLlmContext() {
    if (renderState.error || !renderState.llm) {
      setPanelStatus(agentStatus, "Render the page before copying LLM context", "error");
      return;
    }
    await copyText(renderState.llm, "Copied LLM context");
    setPanelStatus(agentStatus, "Copied LLM context", "ok");
  }
  async function createCloudUser(options = {}) {
    if (!cloudAvailable && !options.silent) return;
    const invitationCode = promptSecret("Invitation code");
    if (!invitationCode) {
      setCloudStatus("Invitation code required", "error");
      return;
    }
    setBusy(true, "Creating user", "warning");
    try {
      const user = await fetchCloudJson("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: cloudUserNameInput.value || "Noma collaborator", invitationCode })
      });
      cloudUser = {
        id: user.id,
        name: user.name,
        token: user.token,
        tokenPreview: user.tokenPreview
      };
      localStorage.setItem(userStorageKey, JSON.stringify(cloudUser));
      cloudUserNameInput.value = cloudUser.name;
      if (!options.silent) setCloudStatus("Created user", "ok");
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  async function ensureSavedBeforeShare() {
    if (dirty) await saveCurrentPage();
  }
  async function createShare(url, role, label) {
    return fetchCloudJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, label })
    });
  }
  function setCurrentPage(page) {
    currentPage = page;
    if (!page) {
      pageTitleInput.value = "";
      sourceInput.value = "";
      dirty = false;
      renderCurrent();
      renderChrome();
      return;
    }
    pageTitleInput.value = page.title;
    sourceInput.value = page.source;
    activeFolder = pageFolder(page.id);
    dirty = false;
    localStorage.setItem(activeDocumentStorageKey, page.id);
    renderCurrent();
    renderChrome();
  }
  function replacePage(page) {
    pages = pages.map((item) => item.id === page.id ? page : item);
    if (currentSite) currentSite = { ...currentSite, documents: pages };
  }
  function selectPage(pageId) {
    if (currentPage?.id === pageId) return true;
    if (!confirmDiscardDirty()) return false;
    const page = pages.find((item) => item.id === pageId);
    if (!page) return false;
    setCurrentPage(page);
    updateAddress();
    return true;
  }
  function renderCurrent() {
    const source = sourceInput.value;
    try {
      const doc = parse(source, { filename: `${currentPage?.id ?? "draft"}.noma` });
      const diagnostics = validate(doc);
      const body = renderHtml(doc, {
        standalone: false,
        allowEscapeHatches: false,
        externalAssets: false,
        interactive: false,
        sourcePositions: true
      });
      renderState = {
        doc,
        diagnostics,
        llm: renderLlm(doc)
      };
      previewFrame.srcdoc = previewDocument(body);
    } catch (error) {
      renderState = {
        doc: null,
        diagnostics: [],
        llm: "",
        error: error instanceof Error ? error : new Error(String(error))
      };
      previewFrame.srcdoc = previewError(errorMessage(error));
    }
    renderDiagnostics();
    renderOutline();
    renderWikiPanel();
    renderChrome();
  }
  function scheduleRender() {
    if (renderTimer !== void 0) window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      renderTimer = void 0;
      renderCurrent();
    }, 180);
  }
  function setViewMode(mode) {
    viewMode = mode;
    if (mode === "preview") panelsOpen = false;
    localStorage.setItem(viewModeStorageKey, viewMode);
    localStorage.setItem(panelsOpenStorageKey, panelsOpen ? "true" : "false");
    renderChrome();
    renderCurrent();
  }
  function renderChrome() {
    const shell = document.querySelector(".cloud-shell");
    if (shell) {
      shell.dataset.viewMode = viewMode;
      shell.dataset.panels = panelsOpen ? "open" : "closed";
    }
    documentGrid.style.setProperty("--source-pane-width", `${splitSourceRatio}%`);
    cloudUserNameInput.disabled = busy;
    newUserButton.disabled = busy || !cloudAvailable;
    copyUserIdButton.disabled = busy || !cloudUser;
    copyUserTokenButton.disabled = busy || !cloudUser;
    themeToggleButton.textContent = themeMode === "dark" ? "Light" : "Dark";
    themeToggleButton.setAttribute("aria-pressed", String(themeMode === "dark"));
    newSpaceButton.disabled = busy || !cloudAvailable || !cloudUser;
    saveSpaceButton.disabled = busy || !canEditSite();
    newPageButton.disabled = busy || !canCreatePage();
    newFolderButton.disabled = busy || !canEditSite();
    savePageButton.disabled = busy || !canEditPage() || !currentPage;
    sourceInput.disabled = busy || !canEditPage();
    pageTitleInput.disabled = busy || !canEditPage();
    copyPageLinkButton.disabled = busy || !currentPage;
    copyArtifactLinkButton.disabled = busy || !currentPage;
    copySiteLinkButton.disabled = busy || !currentSite;
    openPublishedSiteButton.disabled = busy || !currentSite;
    inviteUserButton.disabled = busy || !canManagePermissions();
    applyPatchButton.disabled = busy || !canEditPage();
    copyLlmButton.disabled = busy || Boolean(renderState.error) || !renderState.llm;
    togglePanelsButton.setAttribute("aria-pressed", String(panelsOpen));
    togglePanelsButton.textContent = panelsOpen ? "Hide Panels" : "Panels";
    for (const button of [sourceViewButton, splitViewButton, previewViewButton]) {
      button.setAttribute("aria-pressed", String(button.dataset.viewMode === viewMode));
    }
    const role = currentPageRole();
    roleBadge.textContent = role;
    roleBadge.dataset.state = roleRank(role) >= roleRank("editor") ? "ok" : "warning";
    dirtyBadge.textContent = dirty ? "unsaved" : "saved";
    dirtyBadge.dataset.state = dirty ? "dirty" : "ok";
    updatedText.textContent = currentPage ? `Updated ${formatDate(currentPage.updatedAt)}` : "";
    renderNavigation();
  }
  function renderNavigation() {
    siteList.textContent = "";
    if (sites.length === 0 && !currentSite) {
      siteList.append(emptyState("No spaces"));
    } else {
      for (const site of sites) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "site-row";
        button.setAttribute("aria-current", String(currentSite?.id === site.id));
        button.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
        const title = button.querySelector(".row-title");
        const meta = button.querySelector(".row-meta");
        if (title) title.textContent = site.title;
        if (meta) meta.textContent = `${site.documentIds.length} page${site.documentIds.length === 1 ? "" : "s"} / ${site.access?.role ?? site.currentRole ?? "viewer"}`;
        button.addEventListener("click", () => {
          void loadSite(site.id);
        });
        button.addEventListener("contextmenu", (event) => showSiteContextMenu(event, site));
        siteList.append(button);
      }
    }
    pageList.textContent = "";
    if (pages.length === 0) {
      pageList.append(emptyState("No pages"));
      return;
    }
    const groups = groupedPages();
    for (const group of groups) {
      pageList.append(folderRow(group.folder, group.pages.length));
      for (const page of group.pages) {
        pageList.append(pageRow(page));
      }
    }
  }
  function folderRow(folder, pageCount) {
    const row = document.createElement("div");
    row.className = "folder-row";
    row.setAttribute("aria-current", String(sameFolder(activeFolder, folder)));
    const label = document.createElement("button");
    label.type = "button";
    label.className = "folder-label";
    label.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
    const title = label.querySelector(".row-title");
    const meta = label.querySelector(".row-meta");
    if (title) title.textContent = folder || "Pages";
    if (meta) meta.textContent = `${pageCount} page${pageCount === 1 ? "" : "s"}`;
    label.addEventListener("click", () => {
      activeFolder = folder;
      setCloudStatus(folder ? `Selected ${folder}` : "Selected Pages", "ok");
      renderChrome();
    });
    row.addEventListener("contextmenu", (event) => showFolderContextMenu(event, folder));
    const actions = document.createElement("div");
    actions.className = "folder-actions";
    const addPage = iconButton("+", folder ? `New page in ${folder}` : "New page in Pages", () => {
      activeFolder = folder;
      void createPage(folder);
    });
    actions.append(addPage);
    if (folder) {
      actions.append(
        iconButton("Rename", `Rename ${folder}`, () => void renameFolder(folder)),
        iconButton("Delete", `Delete ${folder}`, () => void deleteFolder(folder), "danger")
      );
    }
    row.append(label, actions);
    return row;
  }
  function pageRow(page) {
    const row = document.createElement("div");
    row.className = "page-entry";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-row";
    button.setAttribute("aria-current", String(currentPage?.id === page.id));
    button.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
    const title = button.querySelector(".row-title");
    const meta = button.querySelector(".row-meta");
    if (title) title.textContent = page.title;
    if (meta) meta.textContent = `${shortId(page.id)} / ${page.access?.role ?? currentSite?.access?.role ?? "viewer"}`;
    button.addEventListener("click", () => selectPage(page.id));
    row.addEventListener("contextmenu", (event) => showPageContextMenu(event, page));
    const move = iconButton("Move", `Move ${page.title}`, () => void movePage(page.id));
    move.disabled = busy || !canEditSite();
    row.append(button, move);
    return row;
  }
  function groupedPages() {
    const folders = siteFolders(currentSite);
    const rootPages = pages.filter((page) => !pageFolder(page.id));
    return [
      { folder: "", pages: rootPages },
      ...folders.map((folder) => ({ folder, pages: pages.filter((page) => sameFolder(pageFolder(page.id), folder)) }))
    ];
  }
  function siteFolders(site) {
    if (!site) return [];
    return normalizeFolders([...site.folders ?? [], ...Object.values(site.pageFolders ?? {})]);
  }
  function normalizeSite(site) {
    const pageFolders = normalizedPageFolders(site.pageFolders, site.documentIds);
    return {
      ...site,
      folders: normalizeFolders([...site.folders ?? [], ...Object.values(pageFolders)]),
      pageFolders
    };
  }
  function normalizedPageFolders(value, documentIds) {
    const allowed = new Set(documentIds);
    const next = {};
    for (const [pageId, folder] of Object.entries(value ?? {})) {
      if (!allowed.has(pageId)) continue;
      const normalized = normalizeFolderName(folder);
      if (normalized) next[pageId] = normalized;
    }
    return next;
  }
  function pageFolder(pageId) {
    return normalizeFolderName(currentSite?.pageFolders?.[pageId] ?? "");
  }
  function normalizeFolders(values) {
    const seen = /* @__PURE__ */ new Set();
    const next = [];
    for (const value of values) {
      const folder = normalizeFolderName(value ?? "");
      if (!folder) continue;
      const key = folder.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(folder);
    }
    return next.slice(0, 80);
  }
  function normalizeFolderName(value) {
    return value.replace(/\\/g, "/").split("/").map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean).join("/").slice(0, 80);
  }
  function sameFolder(left, right) {
    return normalizeFolderName(left).toLowerCase() === normalizeFolderName(right).toLowerCase();
  }
  function promptFolder(label, fallback = "") {
    const value = window.prompt(label, fallback);
    return value === null ? void 0 : normalizeFolderName(value);
  }
  function iconButton(text, title, onClick, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = variant === "danger" ? "row-action row-action-danger" : "row-action";
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }
  function showContextMenu(event, actions) {
    event.preventDefault();
    event.stopPropagation();
    showContextMenuAt(event.clientX, event.clientY, actions);
  }
  function showContextMenuAt(clientX, clientY, actions) {
    closeContextMenu();
    if (actions.length === 0) return;
    const menu = document.createElement("div");
    menu.className = "cloud-context-menu";
    menu.setAttribute("role", "menu");
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());
    for (const item of actions) {
      if (item.separatorBefore) {
        const separator = document.createElement("div");
        separator.className = "cloud-context-menu-separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.disabled = item.disabled === true;
      if (item.danger) button.dataset.danger = "true";
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(label);
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "cloud-context-menu-hint";
        hint.textContent = item.hint;
        button.append(hint);
      }
      button.addEventListener("click", () => {
        if (button.disabled) return;
        closeContextMenu();
        void item.action();
      });
      menu.append(button);
    }
    menu.style.visibility = "hidden";
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, clientX), Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(Math.max(8, clientY), Math.max(8, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
  }
  function closeContextMenu() {
    for (const menu of [...document.querySelectorAll(".cloud-context-menu")]) menu.remove();
  }
  function showSiteContextMenu(event, site) {
    const isCurrent = currentSite?.id === site.id;
    const canEdit = canEditSiteRecord(site);
    showContextMenu(event, [
      {
        label: isCurrent ? "Refresh space" : "Open space",
        hint: site.documentIds.length === 1 ? "1 page" : `${site.documentIds.length} pages`,
        action: () => void loadSite(site.id)
      },
      {
        label: "New page in space",
        disabled: !canEdit,
        action: () => void runWithLoadedSite(site.id, () => createPage())
      },
      {
        label: "New folder",
        disabled: !canEdit,
        action: () => void runWithLoadedSite(site.id, () => createFolder())
      },
      {
        label: "Copy space link",
        disabled: !canEdit,
        separatorBefore: true,
        action: () => void runWithLoadedSite(site.id, () => copySiteLink())
      },
      {
        label: "Save space",
        disabled: !isCurrent || !canEditSite(),
        action: () => void saveCurrentSite()
      }
    ]);
  }
  function showFolderContextMenu(event, folder) {
    const title = folder || "Pages";
    const sameAsCurrentPage = currentPage ? sameFolder(pageFolder(currentPage.id), folder) : false;
    showContextMenu(event, [
      {
        label: "Select folder",
        hint: title,
        action: () => {
          activeFolder = folder;
          setCloudStatus(folder ? `Selected ${folder}` : "Selected Pages", "ok");
          renderChrome();
        }
      },
      {
        label: "New page here",
        disabled: !canCreatePage(),
        action: () => {
          activeFolder = folder;
          void createPage(folder);
        }
      },
      {
        label: "Move current page here",
        disabled: !currentPage || !canEditSite() || sameAsCurrentPage,
        action: () => {
          if (currentPage) void movePageToFolder(currentPage.id, folder);
        }
      },
      {
        label: "Rename folder",
        disabled: !folder || !canEditSite(),
        separatorBefore: true,
        action: () => void renameFolder(folder)
      },
      {
        label: "Delete folder",
        disabled: !folder || !canEditSite(),
        danger: true,
        action: () => void deleteFolder(folder)
      }
    ]);
  }
  function showPageContextMenu(event, page) {
    const isCurrent = currentPage?.id === page.id;
    showContextMenu(event, [
      {
        label: isCurrent ? "Focus page" : "Open page",
        hint: page.access?.role ?? currentSite?.access?.role ?? "viewer",
        action: () => selectPage(page.id)
      },
      {
        label: "Open in preview",
        action: () => {
          if (selectPage(page.id)) setViewMode("preview");
        }
      },
      {
        label: "Move to folder...",
        disabled: !canEditSite(),
        action: () => void movePage(page.id)
      },
      {
        label: activeFolder ? `Move to ${activeFolder}` : "Move to Pages",
        disabled: !canEditSite() || sameFolder(pageFolder(page.id), activeFolder),
        action: () => void movePageToFolder(page.id, activeFolder)
      },
      {
        label: "Copy page link",
        disabled: !currentSite,
        separatorBefore: true,
        action: () => runAfterSelectPage(page.id, () => copyPageLink())
      },
      {
        label: "Copy artifact link",
        action: () => runAfterSelectPage(page.id, () => copyArtifactLink())
      },
      {
        label: "Copy page ID",
        action: () => void copyText(page.id, "Copied page ID")
      },
      {
        label: "Save page",
        disabled: !isCurrent || !canEditPage(),
        separatorBefore: true,
        action: () => void saveCurrentPage()
      }
    ]);
  }
  function showOutlineContextMenu(event, node) {
    const line = node.line;
    const canEdit = canEditPage();
    showContextMenu(event, [
      {
        label: "Focus in source",
        disabled: line === void 0,
        hint: line ? `Line ${line}` : void 0,
        action: () => {
          if (line) focusSourceLine(line);
        }
      },
      {
        label: "Insert section after",
        disabled: !canEdit || line === void 0,
        action: () => {
          if (line) insertSourceBlockAtIndex(sectionEndInsertIndex(line), newSectionSource(line), "Added section from outline");
        }
      },
      {
        label: "Insert text after heading",
        disabled: !canEdit || line === void 0,
        action: () => {
          if (line) insertSourceBlockAtIndex(line, "New paragraph.", "Added paragraph from outline");
        }
      },
      {
        label: "Copy block ID",
        disabled: !node.id,
        separatorBefore: true,
        action: () => {
          if (node.id) void copyText(node.id, "Copied block ID");
        }
      },
      {
        label: "Delete section",
        disabled: !canEdit || node.level <= 1 || line === void 0,
        danger: true,
        action: () => deleteSectionAtLine(line)
      }
    ]);
  }
  function showWikiContextMenu(event, link, kind) {
    showContextMenu(event, [
      {
        label: link.missing ? "Create linked page" : "Open linked page",
        hint: `[[${link.target}]]`,
        action: () => void openWikiTarget(link.target)
      },
      {
        label: "Open backlink source",
        disabled: kind !== "backlink" || !link.page,
        action: () => {
          if (link.page) selectPage(link.page.id);
        }
      },
      {
        label: "Copy wiki link",
        separatorBefore: true,
        action: () => void copyText(`[[${link.target}]]`, "Copied wiki link")
      },
      {
        label: "Copy target",
        action: () => void copyText(link.target, "Copied wiki target")
      }
    ]);
  }
  function showSourceContextMenu(event) {
    showContextMenu(event, [
      {
        label: "Insert section at cursor",
        disabled: !canEditPage(),
        action: () => insertSectionAtCursor()
      },
      {
        label: "Insert text at cursor",
        disabled: !canEditPage(),
        action: () => insertParagraphAtCursor()
      },
      {
        label: "Save page",
        disabled: !canEditPage() || !currentPage,
        separatorBefore: true,
        hint: "Cmd/Ctrl S",
        action: () => void saveCurrentPage()
      },
      {
        label: "Copy LLM context",
        disabled: Boolean(renderState.error) || !renderState.llm,
        action: () => void copyLlmContext()
      },
      {
        label: "Preview only",
        separatorBefore: true,
        action: () => setViewMode("preview")
      },
      {
        label: "Split view",
        action: () => setViewMode("split")
      }
    ]);
  }
  function canEditSiteRecord(site) {
    const role = cloudRole(site.access?.role ?? site.currentRole);
    return Boolean(cloudAvailable && cloudUser && roleRank(role) >= roleRank("editor"));
  }
  function cloudRole(value) {
    return value === "owner" || value === "editor" || value === "viewer" ? value : "viewer";
  }
  async function runWithLoadedSite(siteId, action) {
    if (currentSite?.id !== siteId) await loadSite(siteId);
    if (currentSite?.id === siteId) await action();
  }
  function runAfterSelectPage(pageId, action) {
    if (!selectPage(pageId)) return;
    void action();
  }
  function renderDiagnostics() {
    diagnosticsList.textContent = "";
    if (renderState.error) {
      diagnosticsSummary.textContent = "Render failed";
      diagnosticsSummary.dataset.state = "error";
      diagnosticsList.append(diagnosticRow("error", "render", renderState.error.message));
      return;
    }
    const errors = renderState.diagnostics.filter((item) => item.severity === "error").length;
    const warnings = renderState.diagnostics.filter((item) => item.severity === "warning").length;
    const infos = renderState.diagnostics.filter((item) => item.severity === "info").length;
    diagnosticsSummary.textContent = `${errors} errors / ${warnings} warnings / ${infos} info`;
    diagnosticsSummary.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";
    if (renderState.diagnostics.length === 0) {
      diagnosticsList.append(emptyState("No diagnostics"));
      return;
    }
    for (const item of renderState.diagnostics) {
      diagnosticsList.append(diagnosticRow(item.severity, item.code, item.message, item.pos?.line));
    }
  }
  function renderOutline() {
    outlineList.textContent = "";
    const doc = renderState.doc;
    if (!doc) {
      outlineList.append(emptyState("No outline"));
      return;
    }
    let count = 0;
    for (const node of walk(doc)) {
      if (node.type !== "section") continue;
      count += 1;
      const row = document.createElement("div");
      row.className = "outline-row";
      row.style.paddingLeft = `${Math.min(node.level - 1, 4) * 10 + 9}px`;
      if (node.pos?.line) row.dataset.line = String(node.pos.line);
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = node.title;
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = node.id ?? `h${node.level}`;
      row.addEventListener("click", () => {
        if (node.pos?.line) focusSourceLine(node.pos.line);
      });
      row.addEventListener("contextmenu", (event) => showOutlineContextMenu(event, {
        id: node.id,
        title: node.title,
        level: node.level,
        line: node.pos?.line
      }));
      row.append(title, meta);
      if (node.level > 1 && node.pos?.line && canEditPage()) {
        const deleteButton = iconButton("Delete", `Delete ${node.title}`, () => deleteSectionAtLine(node.pos?.line), "danger");
        row.append(deleteButton);
      }
      outlineList.append(row);
    }
    if (count === 0) outlineList.append(emptyState("No outline"));
  }
  function renderWikiPanel() {
    wikiLinksList.textContent = "";
    if (!currentPage) {
      wikiSummary.textContent = "No wiki links";
      wikiSummary.dataset.state = "ok";
      wikiLinksList.append(emptyState("No page"));
      return;
    }
    const outgoing = wikiLinksForPage(currentPage);
    const backlinks = pages.filter((page) => page.id !== currentPage?.id).flatMap((page) => wikiLinksForPage(page).filter((link) => link.page?.id === currentPage?.id).map((link) => ({ page, link })));
    const missing = outgoing.filter((link) => link.missing);
    wikiSummary.textContent = `${outgoing.length} links / ${backlinks.length} backlinks / ${missing.length} missing`;
    wikiSummary.dataset.state = missing.length > 0 ? "warning" : "ok";
    if (outgoing.length > 0) {
      wikiLinksList.append(wikiLabel("Links"));
      for (const link of outgoing) wikiLinksList.append(wikiLinkRow(link));
    }
    if (backlinks.length > 0) {
      wikiLinksList.append(wikiLabel("Backlinks"));
      for (const item of backlinks) {
        wikiLinksList.append(wikiLinkRow({ ...item.link, page: item.page, missing: false }, "backlink"));
      }
    }
    if (outgoing.length === 0 && backlinks.length === 0) {
      wikiLinksList.append(emptyState("No wiki links on this page"));
    }
  }
  function wikiLabel(text) {
    const label = document.createElement("div");
    label.className = "wiki-section-label";
    label.textContent = text;
    return label;
  }
  function wikiLinkRow(link, kind = "link") {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "wiki-row";
    row.dataset.kind = kind;
    row.dataset.state = link.missing ? "missing" : "resolved";
    row.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
    const title = row.querySelector(".row-title");
    const meta = row.querySelector(".row-meta");
    if (title) title.textContent = link.page?.title ?? link.label;
    if (meta) meta.textContent = link.missing ? `Create [[${link.target}]]` : kind === "backlink" ? `Linked from ${link.page?.title ?? "page"}` : `Open [[${link.target}]]`;
    row.addEventListener("click", () => {
      if (kind === "backlink" && link.page) {
        selectPage(link.page.id);
        return;
      }
      void openWikiTarget(link.target);
    });
    row.addEventListener("contextmenu", (event) => showWikiContextMenu(event, link, kind));
    return row;
  }
  function wikiLinksForPage(page) {
    return extractWikilinks(stripFencedCode(page.source)).map((link) => {
      const resolved = resolveWikiPage(link.target) ?? resolveWikiBlockPage(link.target);
      return {
        ...link,
        ...resolved ? { page: resolved } : {},
        missing: !resolved
      };
    });
  }
  function installPreviewWikiLinks(previewDoc) {
    for (const anchor of [...previewDoc.querySelectorAll("a.noma-ref[href^='#']")]) {
      const target = decodeWikiHrefTarget(anchor.getAttribute("href") ?? "");
      if (!target) continue;
      const page = resolveWikiPage(target) ?? resolveWikiBlockPage(target);
      if (page || canCreatePage()) {
        anchor.dataset.nomaWikiTarget = target;
        anchor.title = page ? `Open ${page.title}` : `Create ${target}`;
      }
      anchor.addEventListener("click", (event) => {
        const currentBlock = target.split("#", 1)[0] ?? target;
        if (!page && hasCurrentDocumentBlock(currentBlock)) return;
        event.preventDefault();
        event.stopPropagation();
        void openWikiTarget(target);
      });
    }
  }
  async function openWikiTarget(target) {
    const page = resolveWikiPage(target) ?? resolveWikiBlockPage(target);
    if (page) {
      selectPage(page.id);
      return;
    }
    if (!canCreatePage()) {
      setCloudStatus(`Missing page: ${target}`, "warning");
      return;
    }
    await createWikiPage(wikiPageTitleFromTarget(target));
  }
  async function createWikiPage(title) {
    if (!currentSite || !cloudUser) return;
    if (dirty) await saveCurrentPage();
    setBusy(true, "Creating wiki page", "warning");
    try {
      const page = await fetchCloudJson(`/api/sites/${encodeURIComponent(currentSite.id)}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          source: wikiPage(title, currentSite.title, currentPage?.title ?? currentSite.title)
        })
      });
      pages = [...pages, page];
      currentSite = {
        ...currentSite,
        documentIds: [...currentSite.documentIds, page.id],
        documents: pages
      };
      setCurrentPage(page);
      await refreshSites({ silent: true });
      updateAddress();
      setCloudStatus(`Created wiki page: ${title}`, "ok");
    } catch (error) {
      setCloudStatus(errorMessage(error), "error");
    } finally {
      setBusy(false);
      renderChrome();
    }
  }
  function resolveWikiPage(target) {
    const base = wikiPageTitleFromTarget(target);
    const key = wikiKey(base);
    const slugKey = slug(base);
    return pages.find((page) => {
      const title = sourceTitle(page.source) || page.title;
      return wikiKey(page.id) === key || wikiKey(page.title) === key || wikiKey(title) === key || slug(page.title) === slugKey || slug(title) === slugKey;
    });
  }
  function resolveWikiBlockPage(target) {
    const base = wikiPageTitleFromTarget(target);
    const key = wikiKey(base);
    for (const page of pages) {
      try {
        const doc = parse(page.source, { filename: `${page.id}.noma` });
        for (const node of walk(doc)) {
          if (wikiKey(node.id ?? "") === key || (node.aliases ?? []).some((alias) => wikiKey(alias) === key)) return page;
        }
      } catch {
        continue;
      }
    }
    return void 0;
  }
  function hasCurrentDocumentBlock(target) {
    const doc = renderState.doc;
    if (!doc) return false;
    for (const node of walk(doc)) {
      if (node.id === target || node.aliases?.includes(target)) return true;
    }
    return false;
  }
  function decodeWikiHrefTarget(href) {
    if (!href.startsWith("#")) return "";
    const raw = href.slice(1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  function wikiPageTitleFromTarget(target) {
    return (target.split("#", 1)[0] || target).trim();
  }
  function wikiKey(value) {
    return value.trim().toLowerCase().replace(/\.noma$/i, "").replace(/\s+/g, " ");
  }
  function stripFencedCode(source) {
    return source.replace(/```[\s\S]*?```/g, "");
  }
  function diagnosticRow(severity, code, message, line) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    row.dataset.severity = severity;
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = `${severity} / ${code}`;
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = line ? `Line ${line}: ${message}` : message;
    row.append(title, meta);
    return row;
  }
  function emptyState(text) {
    const row = document.createElement("div");
    row.className = "empty-state";
    row.textContent = text;
    return row;
  }
  function markDirty() {
    dirty = true;
    if (currentPage) currentPage = { ...currentPage, source: sourceInput.value, title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value) };
    renderChrome();
  }
  function syncTitleFromSource() {
    if (document.activeElement === pageTitleInput) return;
    const title = sourceTitle(sourceInput.value);
    pageTitleInput.value = title;
    if (currentPage) currentPage = { ...currentPage, title };
  }
  function canEditPage() {
    return roleRank(currentPageRole()) >= roleRank("editor");
  }
  function canCreatePage() {
    return Boolean(cloudAvailable && cloudUser && currentSite && roleRank(currentSite.access?.role ?? "viewer") >= roleRank("editor"));
  }
  function canEditSite() {
    return Boolean(cloudAvailable && cloudUser && currentSite && roleRank(currentSite.access?.role ?? "viewer") >= roleRank("editor"));
  }
  function canManagePermissions() {
    const role = currentSite?.access?.role ?? currentPage?.access?.role ?? "viewer";
    return role === "owner";
  }
  function currentPageRole() {
    return currentPage?.access?.role ?? currentSite?.access?.role ?? "viewer";
  }
  function selectedShareRole() {
    return shareRoleSelect.value === "viewer" ? "viewer" : "editor";
  }
  function selectedInviteRole() {
    return inviteRoleSelect.value === "viewer" ? "viewer" : "editor";
  }
  function roleRank(role) {
    return role === "owner" ? 3 : role === "editor" ? 2 : 1;
  }
  async function fetchCloudJson(url, init) {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (cloudUser) headers.set("authorization", `Bearer ${cloudUser.token}`);
    if (shareToken) headers.set("x-noma-share-token", shareToken);
    const response = await fetch(url, {
      ...init,
      headers
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      const text = await response.text();
      try {
        const payload = JSON.parse(text);
        if (payload.error) message = payload.error;
      } catch {
        if (text) message = text;
      }
      if (response.status === 401 && message.includes("Noma Cloud access token required")) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
      }
      throw new Error(message);
    }
    return response.json();
  }
  function parsePatchOps(text) {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || typeof item !== "object" || typeof item.op !== "string") {
        throw new Error("Patch operations must be objects with an op field");
      }
    }
    return list;
  }
  function previewDocument(body) {
    const previewChrome = themeMode === "dark" ? "#111820" : "#f4f1e9";
    const previewBorder = themeMode === "dark" ? "#37323d" : "#e6dfd2";
    const previewShadow = themeMode === "dark" ? "0 24px 70px -46px rgba(0,0,0,.86)" : "0 24px 70px -46px rgba(32,36,42,.42)";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
${default_default}
body{margin:0;padding:28px;background:${previewChrome};color:#20242a}
.noma-document{max-width:${previewPaperWidth}px;margin:0 auto;background:#fffefa;border:1px solid ${previewBorder};box-shadow:${previewShadow};padding:44px 52px}
@media(max-width:720px){body{padding:14px}.noma-document{padding:24px 20px}}
</style>
</head>
<body><main class="noma-document">${body}</main></body>
</html>`;
  }
  function installPreviewEditing() {
    const previewDoc = previewFrame.contentDocument;
    if (!previewDoc) return;
    applyPreviewPaperWidth(previewDoc);
    installPreviewWikiLinks(previewDoc);
    if (!renderState.error && canEditPage()) installPreviewContextMenus(previewDoc);
    if (viewMode !== "preview" || renderState.error || !canEditPage()) return;
    const style = previewDoc.createElement("style");
    style.textContent = previewEditCss();
    previewDoc.head.append(style);
    let selectedElement;
    const toolbar = createPreviewToolbar(previewDoc, (kind) => {
      if (!selectedElement) return;
      insertPreviewBlockAfter(selectedElement, kind);
    }, () => {
      if (!selectedElement) return;
      deletePreviewSection(selectedElement);
    });
    const selectElement = (element) => {
      if (selectedElement && selectedElement !== element) selectedElement.classList.remove("noma-preview-selected");
      selectedElement = element;
      selectedElement.classList.add("noma-preview-selected");
      toolbar.dataset.selectedKind = element.dataset.nomaEditable ?? "";
      placePreviewToolbar(toolbar, selectedElement);
    };
    previewDoc.addEventListener("scroll", () => {
      if (selectedElement) placePreviewToolbar(toolbar, selectedElement);
    });
    for (const element of [...previewDoc.querySelectorAll("[data-noma-editable]")]) {
      const kind = element.dataset.nomaEditable;
      if (!isPreviewEditKind(kind)) continue;
      element.contentEditable = "true";
      element.spellcheck = true;
      element.tabIndex = 0;
      element.dataset.nomaOriginalText = editableText(element);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        selectElement(element);
      });
      element.addEventListener("focus", () => {
        element.dataset.nomaEditing = "true";
        selectElement(element);
      });
      element.addEventListener("blur", () => {
        delete element.dataset.nomaEditing;
        commitPreviewEdit(element);
      });
      element.addEventListener("keydown", (event) => handlePreviewEditKeydown(event, element));
      element.addEventListener("paste", (event) => pastePlainText(event, element));
    }
    previewDoc.addEventListener("click", (event) => {
      const view = previewDoc.defaultView;
      const target = view && event.target instanceof view.Element ? event.target : void 0;
      if (target?.closest(".noma-preview-toolbar, .noma-preview-resize-handle, .noma-preview-end-add")) return;
      if (selectedElement) selectedElement.classList.remove("noma-preview-selected");
      selectedElement = void 0;
      toolbar.dataset.visible = "false";
    });
    installPreviewPaperResize(previewDoc);
    installPreviewEndAdd(previewDoc);
    focusPendingPreviewLine(previewDoc);
  }
  function installPreviewContextMenus(previewDoc) {
    previewDoc.addEventListener("click", () => closeContextMenu());
    previewDoc.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeContextMenu();
    });
    for (const element of [...previewDoc.querySelectorAll("[data-noma-editable]")]) {
      const kind = element.dataset.nomaEditable;
      if (!isPreviewEditKind(kind)) continue;
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const frameRect = previewFrame.getBoundingClientRect();
        showPreviewContextMenuAt(frameRect.left + event.clientX, frameRect.top + event.clientY, element);
      });
    }
  }
  function showPreviewContextMenuAt(clientX, clientY, element) {
    const line = positiveInt(element.dataset.nomaLine);
    const kind = element.dataset.nomaEditable;
    const blockId = previewElementBlockId(element);
    showContextMenuAt(clientX, clientY, [
      {
        label: "Edit in source",
        disabled: line === void 0,
        hint: line ? `Line ${line}` : void 0,
        action: () => {
          if (line) focusSourceLine(line);
        }
      },
      {
        label: "Add section after",
        action: () => insertPreviewBlockAfter(element, "section")
      },
      {
        label: "Add text after",
        action: () => insertPreviewBlockAfter(element, "paragraph")
      },
      {
        label: "Copy block ID",
        disabled: !blockId,
        separatorBefore: true,
        action: () => {
          if (blockId) void copyText(blockId, "Copied block ID");
        }
      },
      {
        label: "Delete section",
        disabled: kind !== "section",
        danger: true,
        action: () => deletePreviewSection(element)
      }
    ]);
  }
  function previewElementBlockId(element) {
    const owned = element.closest("[id]");
    return owned?.id || element.closest("section[id]")?.id;
  }
  function previewEditCss() {
    return `
.noma-document {
  position: relative;
}
[data-noma-editable][contenteditable="true"] {
  cursor: text;
  outline: 1px dashed rgba(15, 102, 107, 0.36);
  outline-offset: 5px;
  border-radius: 3px;
}
[data-noma-editable][contenteditable="true"]:hover {
  outline-color: rgba(15, 102, 107, 0.62);
}
[data-noma-editable][data-noma-editing="true"] {
  background: rgba(237, 247, 245, 0.72);
  outline: 2px solid #0f666b;
}
[data-noma-editable].noma-preview-selected:not([data-noma-editing="true"]) {
  outline: 2px solid rgba(15, 102, 107, 0.64);
}
.noma-preview-toolbar {
  position: fixed;
  z-index: 50;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(15, 102, 107, 0.28);
  border-radius: 8px;
  background: rgba(255, 253, 248, 0.96);
  box-shadow: 0 14px 34px -24px rgba(20, 28, 34, 0.5);
}
.noma-preview-toolbar[data-visible="true"] {
  display: inline-flex;
}
.noma-preview-toolbar button,
.noma-preview-end-add {
  min-height: 26px;
  border: 1px solid rgba(15, 102, 107, 0.22);
  border-radius: 6px;
  background: #fffefa;
  color: #124d55;
  padding: 0 8px;
  font: 700 12px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  cursor: pointer;
}
.noma-preview-toolbar button:hover,
.noma-preview-end-add:hover {
  border-color: rgba(15, 102, 107, 0.58);
  background: #edf7f5;
}
.noma-preview-toolbar .noma-preview-delete-section {
  display: none;
  color: #9c342e;
}
.noma-preview-toolbar[data-selected-kind="section"] .noma-preview-delete-section {
  display: inline-block;
}
.noma-preview-toolbar .noma-preview-delete-section:hover {
  border-color: rgba(163, 58, 50, 0.48);
  background: #fbebe9;
}
.noma-preview-resize-handle {
  position: absolute;
  z-index: 45;
  top: 18px;
  right: -13px;
  bottom: 18px;
  width: 18px;
  cursor: ew-resize;
  border-radius: 999px;
}
.noma-preview-resize-handle::before {
  content: "";
  position: absolute;
  top: 50%;
  right: 6px;
  width: 4px;
  height: 72px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: rgba(15, 102, 107, 0.38);
}
.noma-preview-resize-handle:hover::before,
.noma-preview-resize-handle:focus-visible::before {
  background: #0f666b;
}
.noma-preview-end-add {
  display: block;
  margin: 32px auto 0;
}
`;
  }
  function createPreviewToolbar(previewDoc, onInsert, onDeleteSection) {
    const toolbar = previewDoc.createElement("div");
    toolbar.className = "noma-preview-toolbar";
    toolbar.dataset.visible = "false";
    toolbar.setAttribute("aria-label", "Preview block actions");
    const sectionButton = previewDoc.createElement("button");
    sectionButton.type = "button";
    sectionButton.textContent = "+ Section";
    sectionButton.title = "Add a section after this block";
    sectionButton.addEventListener("click", () => onInsert("section"));
    const paragraphButton = previewDoc.createElement("button");
    paragraphButton.type = "button";
    paragraphButton.textContent = "+ Text";
    paragraphButton.title = "Add a paragraph after this block";
    paragraphButton.addEventListener("click", () => onInsert("paragraph"));
    const deleteButton = previewDoc.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "noma-preview-delete-section";
    deleteButton.textContent = "Delete";
    deleteButton.title = "Delete this section";
    deleteButton.addEventListener("click", () => onDeleteSection());
    toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
    toolbar.append(sectionButton, paragraphButton, deleteButton);
    previewDoc.body.append(toolbar);
    return toolbar;
  }
  function placePreviewToolbar(toolbar, element) {
    const doc = element.ownerDocument;
    const rect = element.getBoundingClientRect();
    const top = Math.max(8, rect.top - 38);
    const maxLeft = Math.max(8, doc.documentElement.clientWidth - toolbar.offsetWidth - 8);
    const left = Math.min(maxLeft, Math.max(8, rect.right - toolbar.offsetWidth));
    toolbar.style.top = `${top}px`;
    toolbar.style.left = `${left}px`;
    toolbar.dataset.visible = "true";
  }
  function installPreviewPaperResize(previewDoc) {
    const paper = previewDoc.querySelector(".noma-document");
    if (!paper) return;
    const handle = previewDoc.createElement("div");
    handle.className = "noma-preview-resize-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize preview paper");
    handle.title = "Drag to resize preview paper";
    handle.addEventListener("pointerdown", (event) => startPreviewPaperResize(event, paper));
    handle.addEventListener("keydown", (event) => handlePreviewPaperResizeKeydown(event, paper));
    paper.append(handle);
  }
  function installPreviewEndAdd(previewDoc) {
    const paper = previewDoc.querySelector(".noma-document");
    if (!paper) return;
    const button = previewDoc.createElement("button");
    button.type = "button";
    button.className = "noma-preview-end-add";
    button.textContent = "+ Section";
    button.title = "Add a section at the end of the page";
    button.addEventListener("click", () => insertSectionAtEnd());
    paper.append(button);
  }
  function applyPreviewPaperWidth(previewDoc) {
    const paper = previewDoc.querySelector(".noma-document");
    if (paper) paper.style.maxWidth = `${previewPaperWidth}px`;
  }
  function startSplitResize(event) {
    if (viewMode !== "split") return;
    event.preventDefault();
    const rect = documentGrid.getBoundingClientRect();
    documentGrid.dataset.resizing = "true";
    splitResizeHandle.setPointerCapture(event.pointerId);
    const onMove = (moveEvent) => {
      const nextRatio = (moveEvent.clientX - rect.left) / rect.width * 100;
      setSplitSourceRatio(nextRatio);
    };
    const onUp = () => {
      delete documentGrid.dataset.resizing;
      splitResizeHandle.removeEventListener("pointermove", onMove);
      splitResizeHandle.removeEventListener("pointerup", onUp);
      splitResizeHandle.removeEventListener("pointercancel", onUp);
      setCloudStatus("Resized split view", "ok");
    };
    splitResizeHandle.addEventListener("pointermove", onMove);
    splitResizeHandle.addEventListener("pointerup", onUp);
    splitResizeHandle.addEventListener("pointercancel", onUp);
  }
  function handleSplitResizeKeydown(event) {
    if (viewMode !== "split") return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSplitSourceRatio(splitSourceRatio + (event.key === "ArrowRight" ? 3 : -3));
    setCloudStatus("Resized split view", "ok");
  }
  function setSplitSourceRatio(value) {
    splitSourceRatio = Math.round(clamp(value, 30, 66) * 10) / 10;
    localStorage.setItem(splitSourceRatioStorageKey, String(splitSourceRatio));
    documentGrid.style.setProperty("--source-pane-width", `${splitSourceRatio}%`);
  }
  function startPreviewPaperResize(event, paper) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paper.getBoundingClientRect().width;
    const ownerWindow = paper.ownerDocument.defaultView;
    if (!handle || !ownerWindow) return;
    handle.setPointerCapture(event.pointerId);
    const onMove = (moveEvent) => {
      const nextWidth = startWidth + (moveEvent.clientX - startX) * 2;
      setPreviewPaperWidth(nextWidth, paper);
    };
    const onUp = () => {
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onUp);
      ownerWindow.removeEventListener("pointercancel", onUp);
      setCloudStatus("Resized preview paper", "ok");
    };
    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onUp);
    ownerWindow.addEventListener("pointercancel", onUp);
  }
  function handlePreviewPaperResizeKeydown(event, paper) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    setPreviewPaperWidth(previewPaperWidth + (event.key === "ArrowRight" ? 40 : -40), paper);
    setCloudStatus("Resized preview paper", "ok");
  }
  function setPreviewPaperWidth(value, paper) {
    previewPaperWidth = Math.round(clamp(value, 680, 1280));
    localStorage.setItem(previewPaperWidthStorageKey, String(previewPaperWidth));
    if (paper) paper.style.maxWidth = `${previewPaperWidth}px`;
  }
  function insertPreviewBlockAfter(element, kind) {
    const editableKind = element.dataset.nomaEditable;
    const line = positiveInt(element.dataset.nomaLine);
    const endLine = positiveInt(element.dataset.nomaEndLine) ?? line;
    if (!isPreviewEditKind(editableKind) || line === void 0 || endLine === void 0) {
      setCloudStatus("Preview insert cannot sync", "warning");
      return;
    }
    if (kind === "section") {
      const index2 = editableKind === "section" ? sectionEndInsertIndex(line) : endLine;
      insertSourceBlockAtIndex(index2, newSectionSource(line), "Added section from preview");
      return;
    }
    const index = editableKind === "section" ? line : endLine;
    insertSourceBlockAtIndex(index, "New paragraph.", "Added paragraph from preview");
  }
  function insertSectionAtEnd() {
    const lines = sourceInput.value.split("\n");
    insertSourceBlockAtIndex(lines.length, newSectionSource(lines.length), "Added section at end");
  }
  function insertSectionAtCursor() {
    const index = sourceCursorInsertIndex();
    insertSourceBlockAtIndex(index, newSectionSource(index + 1), "Added section at cursor");
  }
  function insertParagraphAtCursor() {
    insertSourceBlockAtIndex(sourceCursorInsertIndex(), "New paragraph.", "Added paragraph at cursor");
  }
  function sourceCursorInsertIndex() {
    const beforeCursor = sourceInput.value.slice(0, sourceInput.selectionStart);
    return beforeCursor.split("\n").length;
  }
  function insertSourceBlockAtIndex(index, sourceBlock, status) {
    if (renderTimer !== void 0) {
      window.clearTimeout(renderTimer);
      renderTimer = void 0;
    }
    const lines = sourceInput.value.split("\n");
    const boundedIndex = Math.max(0, Math.min(lines.length, index));
    const needsPrefix = boundedIndex > 0 && lines[boundedIndex - 1]?.trim() !== "";
    const needsSuffix = boundedIndex < lines.length && lines[boundedIndex]?.trim() !== "";
    const insertLines = [
      ...needsPrefix ? [""] : [],
      ...sourceBlock.split("\n"),
      ...needsSuffix ? [""] : []
    ];
    pendingPreviewFocusLine = boundedIndex + (needsPrefix ? 2 : 1);
    lines.splice(boundedIndex, 0, ...insertLines);
    sourceInput.value = lines.join("\n");
    syncTitleFromSource();
    markDirty();
    setCloudStatus(status, "ok");
    renderCurrent();
  }
  function newSectionSource(contextLine) {
    const currentLevel = headingLevelAtLine(contextLine) ?? nearestHeadingLevelBefore(contextLine) ?? 2;
    const level = Math.max(2, currentLevel);
    const id = uniqueSourceId("new-section");
    return `${"#".repeat(level)} New section {id="${id}"}

Start writing here.`;
  }
  function sectionEndInsertIndex(headingLine) {
    const lines = sourceInput.value.split("\n");
    const level = headingLevelAtLine(headingLine);
    if (level === void 0) return headingLine;
    for (let index = headingLine; index < lines.length; index += 1) {
      const nextLevel = headingLevel(lines[index]);
      if (nextLevel !== void 0 && nextLevel <= level) return index;
    }
    return lines.length;
  }
  function headingLevelAtLine(line) {
    const lines = sourceInput.value.split("\n");
    return headingLevel(lines[line - 1]);
  }
  function nearestHeadingLevelBefore(line) {
    const lines = sourceInput.value.split("\n");
    for (let index = Math.min(line - 1, lines.length - 1); index >= 0; index -= 1) {
      const level = headingLevel(lines[index]);
      if (level !== void 0) return level;
    }
    return void 0;
  }
  function headingLevel(line) {
    const match = /^(#{1,6})\s+/.exec(line ?? "");
    return match?.[1]?.length;
  }
  function uniqueSourceId(base) {
    const ids = new Set(
      [...sourceInput.value.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]).filter((id) => id !== void 0)
    );
    if (!ids.has(base)) return base;
    for (let suffix = 2; suffix < 1e3; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!ids.has(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
  function focusPendingPreviewLine(previewDoc) {
    const line = pendingPreviewFocusLine;
    if (line === void 0) return;
    pendingPreviewFocusLine = void 0;
    window.setTimeout(() => {
      const element = previewDoc.querySelector(`[data-noma-line="${line}"]`);
      if (!element) return;
      element.focus();
      selectElementContents(element);
    }, 0);
  }
  function selectElementContents(element) {
    const selection = element.ownerDocument.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
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
      void saveCurrentPage();
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
      setCloudStatus("Rendered edit cannot sync", "warning");
      return;
    }
    const replacement = previewSourceReplacement(kind, line, endLine, nextText);
    if (replacement === null) {
      setCloudStatus("Rendered edit cannot sync", "warning");
      return;
    }
    replaceSourceLines(line, endLine, replacement);
    setCloudStatus("Synced preview edit", "ok");
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
        return `${match[1] ?? ""}${normalizeInlineText(text) || "Untitled"}${match[3] ?? ""}`;
      }
      case "paragraph":
        return normalizeBlockText(text);
      case "list_item": {
        const match = /^(\s*(?:[-*]|\d+\.)\s+)(.*)$/.exec(currentLine);
        if (!match) return null;
        return `${match[1] ?? ""}${normalizeInlineText(text)}`;
      }
      case "quote": {
        const body = normalizeBlockText(text);
        const quoteLines = body ? body.split("\n") : [""];
        return quoteLines.map((quoteLine) => `> ${quoteLine}`).join("\n");
      }
    }
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
    syncTitleFromSource();
    markDirty();
    renderCurrent();
  }
  function deletePreviewSection(element) {
    if (element.dataset.nomaEditable !== "section") {
      setCloudStatus("Select a section heading to delete", "warning");
      return;
    }
    deleteSectionAtLine(positiveInt(element.dataset.nomaLine));
  }
  function deleteSectionAtLine(line) {
    if (!line || !canEditPage()) return;
    const level = headingLevelAtLine(line);
    if (level === void 0 || level <= 1) {
      setCloudStatus("Root section cannot be deleted here", "warning");
      return;
    }
    const title = sourceSectionTitleAtLine(line);
    if (!window.confirm(`Delete section "${title}" and all nested content?`)) return;
    if (renderTimer !== void 0) {
      window.clearTimeout(renderTimer);
      renderTimer = void 0;
    }
    const lines = sourceInput.value.split("\n");
    const startIndex = line - 1;
    const endIndex = sectionEndInsertIndex(line);
    lines.splice(startIndex, Math.max(1, endIndex - startIndex));
    collapseBlankAt(lines, startIndex);
    sourceInput.value = lines.join("\n");
    syncTitleFromSource();
    markDirty();
    setCloudStatus(`Deleted section: ${title}`, "ok");
    renderCurrent();
  }
  function collapseBlankAt(lines, index) {
    const bounded = Math.max(1, Math.min(lines.length - 1, index));
    while (bounded < lines.length && lines[bounded - 1]?.trim() === "" && lines[bounded]?.trim() === "") {
      lines.splice(bounded, 1);
    }
  }
  function sourceSectionTitleAtLine(line) {
    const currentLine = sourceInput.value.split("\n")[line - 1] ?? "";
    return currentLine.replace(/^#{1,6}\s+/, "").replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled";
  }
  function focusSourceLine(line) {
    const lines = sourceInput.value.split("\n");
    const boundedLine = Math.max(1, Math.min(lines.length, line));
    const offset = lines.slice(0, boundedLine - 1).join("\n").length + (boundedLine > 1 ? 1 : 0);
    sourceInput.focus();
    sourceInput.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(window.getComputedStyle(sourceInput).lineHeight) || 20;
    sourceInput.scrollTop = Math.max(0, (boundedLine - 4) * lineHeight);
  }
  function normalizeInlineText(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function normalizeBlockText(text) {
    return text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
  }
  function positiveInt(value) {
    if (!value) return void 0;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : void 0;
  }
  function isPreviewEditKind(value) {
    return value === "section" || value === "paragraph" || value === "list_item" || value === "quote";
  }
  function previewError(message) {
    return `<!doctype html><html lang="en"><body style="font:14px sans-serif;color:#a33a32;padding:20px">${escapeHtml2(message)}</body></html>`;
  }
  function starterPage(title, siteName) {
    return `# ${title} {id="${slug(title) || "intro"}"}

::abstract{id="abstract" status="draft"}
${siteName} draft abstract. State the research question, method, primary result, and confidence in one paragraph.
::

## Research Question {id="research-question"}

::claim{id="claim-main" confidence=0.68}
The central claim of this paper goes here.
::

::evidence{id="evidence-primary" for="claim-main" source="source-primary"}
Summarize the strongest evidence for the central claim.
::

## Methods {id="methods"}

Describe the study design, corpus, data collection window, and analysis method.

::table{id="review-checklist" header align="l,c,l"}
| Section | Status | Owner |
| Abstract | draft | Research |
| Methods | draft | Research |
| Evidence | needs source check | Reviewer |
::

## Findings {id="findings"}

Draft the result narrative here. Use stable IDs on claims, evidence, figures, tables, citations, and review tasks so collaborators and agents can patch exactly the right block.

::citation{id="source-primary" source="Primary source placeholder" url="https://example.com/source" accessed="2026-06-07"}
Replace this placeholder with the paper's canonical source.
::

::bibliography{id="references"}
::

## Review Queue {id="review-queue"}

::agent_task{id="task-source-check" scope="paper-review" owner="reviewer"}
Verify the primary source, update the citation metadata, and leave unrelated blocks unchanged.
::
`;
  }
  function wikiPage(title, siteName, relatedTitle) {
    const id = slug(title) || "wiki-page";
    return `# ${title} {id="${id}"}

::summary{id="summary"}
Summarize what this page captures in ${siteName}. Keep it connected to the related pages below.
::

## Notes {id="notes"}

Start writing the durable explanation here.

## Related {id="related"}

- [[${relatedTitle}]]

## Agent Tasks {id="agent-tasks"}

::agent_task{id="task-expand-${id}" scope="wiki-maintenance" owner="agent"}
Expand this page with definitions, sources, backlinks, and missing related pages without rewriting unrelated pages.
::
`;
  }
  function replaceFirstHeading(source, title) {
    if (/^#\s+.+$/m.test(source)) {
      return source.replace(/^#\s+(.+?)(\s+\{[^}]*\})?\s*$/m, (_match, _oldTitle, attrs) => {
        return `# ${title}${attrs ?? ""}`;
      });
    }
    return `# ${title} {id="${slug(title) || "intro"}"}

${source}`;
  }
  function sourceTitle(source) {
    return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled Page";
  }
  function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  }
  function promptName(label, fallback) {
    const value = window.prompt(label, fallback);
    return value?.trim() || fallback;
  }
  function promptSecret(label) {
    const value = window.prompt(label);
    return value?.trim() || void 0;
  }
  function confirmDiscardDirty() {
    return !dirty || window.confirm("Discard unsaved page changes?");
  }
  function updateAddress() {
    const params = new URLSearchParams();
    if (currentSite) params.set("site", currentSite.id);
    if (currentPage) params.set("doc", currentPage.id);
    if (shareToken) params.set("share", shareToken);
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }
  function absoluteUrl(path) {
    return new URL(path, window.location.origin).toString();
  }
  function cloudAppDocumentUrl(id, token) {
    return absoluteUrl(`/cloud.html?doc=${encodeURIComponent(id)}&share=${encodeURIComponent(token)}`);
  }
  function cloudAppSiteUrl(id, token) {
    return absoluteUrl(`/cloud.html?site=${encodeURIComponent(id)}&share=${encodeURIComponent(token)}`);
  }
  function readCloudUser() {
    const stored = localStorage.getItem(userStorageKey);
    if (!stored) return void 0;
    try {
      const parsed = JSON.parse(stored);
      if (parsed.id && parsed.name && parsed.token) {
        return {
          id: parsed.id,
          name: parsed.name,
          token: parsed.token,
          tokenPreview: parsed.tokenPreview
        };
      }
    } catch {
      return void 0;
    }
    return void 0;
  }
  function readShareToken() {
    const token = query.get("share");
    return token && /^ns_[A-Za-z0-9_-]{16,}$/.test(token) ? token : void 0;
  }
  function readCloudId(value) {
    return value && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : void 0;
  }
  function readViewMode() {
    const stored = localStorage.getItem(viewModeStorageKey);
    return stored === "source" || stored === "preview" ? stored : "split";
  }
  function readPanelsOpen() {
    return localStorage.getItem(panelsOpenStorageKey) !== "false";
  }
  function readSplitSourceRatio() {
    const stored = localStorage.getItem(splitSourceRatioStorageKey);
    if (stored === null) return 46;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clamp(parsed, 30, 66) : 46;
  }
  function readPreviewPaperWidth() {
    const stored = localStorage.getItem(previewPaperWidthStorageKey);
    if (stored === null) return 1040;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clamp(parsed, 680, 1280) : 1040;
  }
  function readThemeMode() {
    const stored = localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyThemeMode() {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function setBusy(value, message, state = "warning") {
    busy = value;
    if (message) setCloudStatus(message, state);
    renderChrome();
  }
  function setCloudStatus(message, state) {
    cloudStatus.textContent = message;
    cloudStatus.dataset.state = state;
  }
  function setPanelStatus(element, message, state) {
    element.textContent = message;
    element.dataset.state = state;
  }
  function emptyRenderState() {
    return {
      doc: null,
      diagnostics: [],
      llm: ""
    };
  }
  async function copyText(text, status) {
    await navigator.clipboard.writeText(text);
    setCloudStatus(status, "ok");
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(void 0, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }
  function shortId(value) {
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }
  function escapeHtml2(value) {
    return value.replace(/[&<>"']/g, (char) => {
      switch (char) {
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
