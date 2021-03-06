import root from 'window-or-global';

var esprima = require('esprima');

var escodegen = require('escodegen');

export var debug = [false];

/* Experiments showed that flow is not nearly as useful as evaling code to get
 * the types. */
export var useFlow = [false];

export var enableAllIfBranches = [false];

var useBoolWrapper = false;
var boolWrapper = '';
var boolType = 'bool';
if (useBoolWrapper) {
  boolWrapper = 'Js.to_bool';
  boolType = 'Js.boolean';
}

var consoleLog = function() {
  if (debug[0]) {
    console.log(...arguments);
  }
};

var modMap = {
  'PIXI': 'pixi.js',
  'THREE': 'three.js'
};

var globalsMap = {
  'document': {},
  'window': {},
  'console': {},
  'Math': {},
  'fakeConsole': {}
};

var reserved = 'and,as,assert,asr,begin,class,constraint,do,done,downto,else,end,exception,external,false,for,fun,function,functor,if,in,include,inherit,initializer,land,lazy,let,lor,lsl,lsr,lxor,match,method,mod,module,mutable,new,nonrec,object,of,open,or,private,rec,sig,struct,then,to,true,try,type,val,virtual,when,while,with';
reserved = reserved.split(',');

var state;

var statementTerminator = ';\n';
var globalIdName = '_ReasonMLId';
var globalIndexName = '_ReasonMLIndex';
var globalTypeName = '_ReasonMLType';
var globalTypeDecl = '_ReasonMLTypeDecl';

function initState(code) {
  var toResolve;
  var toReject;
  var promise = new Promise(function (resolve, reject) {
    toResolve = resolve;
    toReject = reject;
  });
  return {
    smallObjectCounter: 0,
    anonymousFunctionCounter: 0,
    reasonTypes: {
      'unknownT': {},
      "unknownFunT('a, 'b)": { decl: "'a => 'b" },
      'recursiveT': {},
      'tooBigObjectT': {}
    },
    reasonExterns: {},
    astCode: code,
    astTypeCount: 0,
    astNodes: [],
    astNodeTypeUnresolved: {},
    astNodeParents: {},
    astNodeObjects: [],
    astMutables: {},
    astNodesDebug: {},
    astTypesResolvedPromise: promise,
    astResolve: toResolve
  };
};

var globalId = 0;

function getType(obj, rootNode, marker) {
  if (marker === undefined) {
    marker = globalId++;
  }
  var byUsage = function(prefix, isFun) {
    var externName = getExternName(state.astCode, rootNode);
    if (rootNode.type == 'FunctionExpression') {
      externName = 'Anon' + state.anonymousFunctionCounter.toString();
      state.anonymousFunctionCounter++;
    }
    var usageT = prefix + externName + 'T';
    state.reasonTypes[usageT] = {};
    /*
    if (isFun) {
      var usageArgT = prefix + externName + 'ArgT';
      var usageRetT = prefix + externName + 'RetT';
      state.reasonTypes[usageT] = {
        decl: usageArgT + ' => ' + usageRetT + ' and ' + usageArgT + ' and ' + usageRetT
      };
    }
    */
    obj[globalTypeName] = usageT;
    obj[globalTypeDecl] = state.reasonTypes[obj[globalTypeName]];
    return usageT;
  };
  switch (typeof(obj)) {
    case 'number':
      if (obj % 1 === 0) {
        return 'int';
      } else {
        return 'float';
      }
      break;
    case 'boolean':
      return boolType;
      break;
    case 'string':
      return 'string';
      break;
    case 'object':
      if (obj === null || obj === undefined) {
        return 'Js.Nullable.t(unknownT)'
        break;
      }
      var typeName = undefined;
      try {
        typeName = obj.constructor.name;
      } catch (error) {
      }
      if (typeName != undefined && typeName != "Object" && typeName != "Array") {
        obj[globalTypeName] = 'app' + typeName + 'T';
        obj[globalTypeDecl] = {};
        state.reasonTypes[obj[globalTypeName]] = {};
        /* TODO: give type a body? */
      }
      if (globalTypeName in obj) {
        state.reasonTypes[obj[globalTypeName]] = obj[globalTypeDecl];
        return obj[globalTypeName];
      };
      if (globalIdName in obj && globalIdName == marker) {
        return 'recursiveT';
      };
      obj[globalIdName] = marker;
      if (Array.isArray(obj)) {
        if (obj.length > 0) {
          var t = getType(obj[0], rootNode, marker);
          for (var i = 1; i < obj.length; i++) {
            var t2 = getType(obj[i], rootNode, marker);
            if (t !== t2) {
              return 'array(unknownT)';
            }
          }
          return 'array(' + t + ')';
        } else {
          return 'array(unknownT)';
        };
      } else {
        var childTypes = [];
        var propCount = 0;
        var propLimit = 20;
        for (var prop in obj) {
          if (prop == globalIdName) {
            continue;
          };
          if (!prop.match(/^[a-z0-9]+$/i)) {
            continue;
          }
          if ('hasOwnProperty' in obj && obj.hasOwnProperty(prop) && !isFunction(obj[prop])) {
            childTypes.push('"' + prop + '": ' + getType(obj[prop], rootNode, marker));
            propCount++;
            if (propCount > propLimit) {
              break;
            };
          }
        }
        var t = '{. ';
        t += childTypes.join(', ');
        t += '}';
        if (propCount <= propLimit && propCount > 0) {
          var retval = 'smallObject' + state.smallObjectCounter.toString() + 'T';
          state.reasonTypes[retval] = { decl: t };
          state.smallObjectCounter++;
          return retval;
        } else {
          /*
          return 'tooBigObjectT';
          */
          return byUsage('usage', false);
        };
      }
      break;
    default:
      if (obj === undefined) {
        return 'unit';
      };
      if (isFunction(obj)) {
        return byUsage('usageFun', true);
      };
      return 'unknownT';
      break;
  };
};

function getExpression(s) {
  var newNode = esprima.parse(s);
  newNode = newNode.body[0].expression;
  return newNode;
};

function joinParams(node) {
  var reasonmlArgs = [];
  for (var i = 0; i < node.params.length; i++) {
    reasonmlArgs.push(node.params[i].translate().code);
  }
  return reasonmlArgs.join(', ');
};

function joinArgs(node) {
  var reasonmlArgs = [];
  for (var i = 0; i < node.arguments.length; i++) {
    reasonmlArgs.push(node.arguments[i].translate().code);
  }
  return reasonmlArgs.join(', ');
};

function showNodeError(code, node) {
  var r = node.range;
  var a = r[0];
  var b = r[1];
  var part = code.slice(a, b);
  var errCode = code.slice(0, a - 1) + ' /* BEGIN ERROR */ ' + part + ' /* END ERROR */ ' + code.slice(b);
  /*
  console.error(errCode);
  */
}

function getCode(code, node) {
  var r = node.range;
  var a = r[0];
  var b = r[1];
  var part = code.slice(a, b);
  return part;
};

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
};

function lowercaseFirstLetter(string) {
  return string.charAt(0).toLowerCase() + string.slice(1);
};

function getIdParts(code, node) {
  var parts = [];
  var savePart = function(code, parentNode, node) {
    if (node.type == 'Identifier') {
      parts.push(node.name);
    }
  };
  walk(code, null, node, savePart);
  /*if (parts.length > 4) {
    parts = parts.slice(parts.length - 4);
  }*/
  if (parts.length > 1) {
    parts = parts.slice(parts.length - 1);
  }
  return parts;
}

function getExternName(code, node) {
  /*
  var lexpr = getCode(code, node);
  var parts = lexpr.split('.');
  */
  var parts = getIdParts(code, node);
  var cparts = [];
  for (var i = 0; i < parts.length; i++) {
    cparts[i] = capitalizeFirstLetter(parts[i]);
  }
  return cparts.join('');
};

function getExternCallName(code, node) {
  /*
  var lexpr = getCode(code, node);
  var parts = lexpr.split('.');
  */
  var parts = getIdParts(code, node);
  var cparts = [];
  for (var i = 0; i < parts.length; i++) {
    if (i == 0) {
      if (parts[i].charAt(0).toLowerCase() !== parts[i].charAt(0)) {
        /* Lowercase whole word if first letter is not already lowercase */
        cparts[i] = parts[i].toLowerCase();
      } else {
        cparts[i] = parts[i];
      }
    } else {
      cparts[i] = capitalizeFirstLetter(parts[i]);
    };
  }
  return cparts.join('');
};

function isFunction(functionToCheck) {
 return functionToCheck && {}.toString.call(functionToCheck) === '[object Function]';
}

function addArgTypes(node, argTypes) {
  for (var i = 0; i < node.arguments.length; i++) {
    var arg = node.arguments[i];
    var argType = arg[globalTypeName];
    argTypes.push(argType);
  }
};

function getModName(code, node) {
  var modName = null;
  var resolved = null;
  /* TODO: walk identifiers instead of code snippet */
  var parts = getCode(code, node).replace(/\n/g, '').replace(/ /g, '').split('.');
  if (parts.length > 1) {
    modName = parts[0];
    if (modName in modMap) {
      resolved = modMap[modName];
    };
  };
  return [parts, modName, resolved];
}

function addExtern(externName, value) {
  var decl = declareExtern(externName, value);
  if (!value.isNotExtern && externName in state.reasonExterns) {
    var oldDecl = declareExtern(externName, state.reasonExterns[externName]);
    if (decl !== oldDecl) {
      // Disambiguate by argument types
      externName += value.argTypes.join('').replace(/[.() =>]/g, '') + value.retType;
    } else {
    }
    var decl = declareExtern(externName, value);
    if (externName in state.reasonExterns) {
      var oldDecl = declareExtern(externName, state.reasonExterns[externName]);
      if (decl !== oldDecl) {
        throw new Error('failed to disambiguate: ' + externName);
      }
    }
  }
  state.reasonExterns[externName] = value;
  return externName;
}

function applyExpression(opts, code, node) {
  var attributes = opts.attributes;
  var prefix = '';
  var createId = 'BLAH';
  if (opts.type === 'new') {
    prefix = 'new';
    createId = prefix + getExternName(code, node.callee);
  } else if (opts.type === 'call') {
    prefix = '';
    createId = getExternCallName(code, node.callee);
  }
  createId += node.arguments.length.toString();
  if (prefix == '') {
    createId = lowercaseFirstLetter(createId);
  };
  var [parts, modName, modResolved] = getModName(code, node.callee);
  var callName = parts[parts.length - 1];

  var argTypes = [];
  var objArg = '';
  var reargs = joinArgs(node);
  var isNotExtern = false;
  var objArgType = '';
  if (opts.type === 'call') {
    if (node.callee.type == 'MemberExpression') {
      objArgType = node.callee.object[globalTypeName];
      argTypes.push(objArgType);
      objArg = node.callee.object.translate().code;
      /*
      if (reargs != '') {
        objArg = objArg + ', ';
      };
      */
    } else {
      /* Top level call */
      isNotExtern = !(callName in root) && !(modName in modMap);
      createId = callName;
    };
  };
  addArgTypes(node, argTypes);
  var retType = node[globalTypeName];

  var externName = createId;
  var value = {
    isNotExtern: isNotExtern,
    attributes: attributes,
    argTypes: argTypes,
    retType: retType,
    callName: callName
  };
  /*
  if (modName !== null && opts.type == 'new') {
  */
  if (modName !== null && modResolved !== null && objArg.match(/^[0-9a-zA-Z\.]*$/)) {
    if (opts.type === 'call') {
      /* We use val instead of send if global function on module. */
      attributes[0] = '[@bs.val]';
      objArg = '';
      if (objArgType !== '') {
        argTypes.shift();
      }
    }
    attributes.push('[@bs.module "' + modResolved + '"]');
    if (parts.length > 2) {
      for (var i = 1; i < parts.length - 1; i++) {
        attributes.push('[@bs.scope "' + parts[i] + '"]');
      }
    }
  }
  externName = addExtern(externName, value);
  var translated = {};
  if (objArg !== '') {
    if (reargs !== '') {
      reargs = '(' + reargs + ')'
    }
    translated.code = '(' + objArg + ' |. ' + externName + reargs + ')';
  } else {
    translated.code = externName + "(" + objArg + reargs + ")";
  }
  return translated;
};

function lazy(f) {
  var cached;
  var hasCached = false;
  return function() {
    if (!hasCached) {
      cached = f();
      hasCached = true;
    }
    return cached;
  };
};

/*
 * TODO:
 * - astNodeParents is private. getParent() to access.
 * */
var defaultBody = {
  translate: function(code, node) {
    throw(new Error('unimplemented node type: ' + node.type));
  },
  tests: []
};

function node(nodeObject) {
  if (!('translate' in nodeObject)) {
    throw(new Error('node is missing translate function'));
  }
  if (!('tests' in nodeObject)) {
    nodeObject.tests = [];
  }
  nodeObject.validated = true;
  return nodeObject;
}

var test = {
  statement1: 'fakeConsole.log("shrimp");',
  out1: 'shrimp',
  statement2: 'fakeConsole.log("fish");',
  out2: 'fish'
};

function isMutable(code, node) {
  if (node.type !== 'Identifier') {
    throw new Error('node mutable check only works on Identifier');
  }
  var parentNode = state.astNodeParents[node[globalIndexName]];
  var parentNode2 = state.astNodeParents[parentNode[globalIndexName]];
  var mutable =
    parentNode2.type == 'ForStatement' &&
    parentNode2.test[globalIndexName] == parentNode[globalIndexName];
  var name = node.name;
  mutable = mutable || node.name in state.astMutables;
  return mutable;
}

/* List of syntax nodes from
 * https://github.com/jquery/esprima/blob/master/src/syntax.ts .*/
var processNodes = {
  AssignmentExpression: {
    translate: function(code, node) {
      var translated = {};
      var op = node.operator;
      var leftRML = node.left.translate();
      if (leftRML.codeSet !== undefined) {
        /* Property */
        if (op == '=') {
          translated.code = leftRML.codeSet + '(' + leftRML.codeLeft + ", " + node.right.translate().code + ')';
        } else {
          /* *= /= += -= */
          var op2 = op[0];
          if (node.right[globalTypeName] == 'float') {
              op2 += '.';
          }
          var paddedOp = ' ' + op2 + ' ';
          translated.code =
            leftRML.codeSet +
            '(' + leftRML.codeLeft + ", " +
            '(' + leftRML.code + paddedOp + node.right.translate().code + '))';
        }
      } else {
        /* Plain assignment */
        if (op == '=') {
          var mutable = node.left.type === 'Identifier' && isMutable(code, node.left);
          if (mutable) {
            translated.code = node.left.translate().code + ' := ' + node.right.translate().code;
          } else {
            translated.code = 'let ' + node.left.translate().code + ' = ' + node.right.translate().code;
          }
        } else {
          /* *= /= += -= */
          var op2 = op[0];
          if (node.right[globalTypeName] == 'float') {
              op2 += '.';
          }
          var paddedOp = ' ' + op2 + ' ';
          translated.code =
            node.left.translate().code + ' := ' +
            node.left.translate().code + '^' + paddedOp + '(' + node.right.translate().code + ')';
        }
      }
      return translated;
    },
    tests: []
  },
  AssignmentPattern: defaultBody,
  ArrayExpression: {
    translate: function(code, node) {
      var translated = {};
      var args = [];
      for (var i = 0; i < node.elements.length; i++) {
        args.push(node.elements[i].translate().code);
      }
      translated.code = '[| ' + args.join(', ') + ' |]';
      return translated;
    },
    tests: []
  },
  ArrayPattern: defaultBody,
  ArrowFunctionExpression: defaultBody,
  AwaitExpression: defaultBody,
  BlockStatement: {
    translate: function(code, node) {
      var translated = {};
      var rml = [];
      for (var i = 0; i < node.body.length; i++) {
        var child = node.body[i];
        rml.push(child.translate().code);
      }
      translated.code = '{\n' + rml.join('\n') + '\n' + '}\n';
      return translated;
    },
    tests: []
  },
  BinaryExpression: {
    translate: function(code, node) {
      var translated = {};
      var operator = node.operator;
      if (operator == '%') {
        operator = 'mod';
      }
      var left = node.left.translate().code;
      var right = node.right.translate().code;
      if (node[globalTypeName] === 'float' ||
          node.left[globalTypeName] === 'float' ||
          node.right[globalTypeName] === 'float') {
        operator = operator + '.';
        if (node.left[globalTypeName] == 'int') {
          left = 'float_of_int(' + left + ')';
        }
        if (node.right[globalTypeName] == 'int') {
          right = 'float_of_int(' + right + ')';
        }
      } else if (node[globalTypeName] == 'string' && operator == '+') {
        operator = '++';
        if (node.left[globalTypeName] == 'int') {
          left = 'string_of_int(' + left + ')';
        }
        if (node.right[globalTypeName] == 'int') {
          right = 'string_of_int(' + right + ')';
        }
        if (node.left[globalTypeName] == 'float') {
          left = 'string_of_float(' + left + ')';
        }
        if (node.right[globalTypeName] == 'float') {
          right = 'string_of_float(' + right + ')';
        }
      }
      translated.code = '(' + left + ' ' + operator + ' ' + right + ')';
      return translated;
    },
    tests: []
  },
  BreakStatement: defaultBody,
  CallExpression: {
    translate: function(code, node) {
      var translated = {};
      if (getCode(code, node).startsWith("console.log")) {
        translated.code = 'Js.log(' + joinArgs(node) + ')';
        return translated;
      } else {
        return applyExpression({
            type: 'call',
            attributes: ['[@bs.send]']
          },
          code,
          node);
      }
    },
    tests: []
  },
  CatchClause: defaultBody,
  ClassBody: defaultBody,
  ClassDeclaration: defaultBody,
  ClassExpression: defaultBody,
  ConditionalExpression: {
    translate: function(code, node) {
      var translated = {};
      var first = node.test.translate().code;
      var second = node.consequent.translate().code;
      var third = node.alternate.translate().code;
      if (node.consequent[globalTypeName] != node.alternate[globalTypeName]) {
        if (node.consequent[globalTypeName] == 'string' && node.alternate[globalTypeName] == 'int') {
          third = 'string_of_int(' + third + ')';
        }
      }
      translated.code = 'if (' + boolWrapper + '(' + first + ')) {' + second + '} else {' + third + '}';
      return translated;
    },
    tests: []
  },
  ContinueStatement: defaultBody,
  DoWhileStatement: defaultBody,
  DebuggerStatement: defaultBody,
  EmptyStatement: defaultBody,
  ExportAllDeclaration: defaultBody,
  ExportDefaultDeclaration: defaultBody,
  ExportNamedDeclaration: defaultBody,
  ExportSpecifier: defaultBody,
  ExpressionStatement: {
    translate: function(code, node) {
      var translated = {};
      var prefix = '';
      var suffix = '';
      if (node.expression[globalTypeName] !== 'unit' && node.expression[globalTypeName] !== undefined) {
        /*
        prefix = 'let _ = ';
        */
        /*
        suffix = '|> ignore';
        */
      };
      translated.code = prefix + node.expression.translate().code + suffix;
      var shouldIgnore = node.expression.type !== 'AssignmentExpression';
      var ignore = shouldIgnore ? ' /* |> ignore */ ' : '';
      if (!translated.code.trim().endsWith(';')) {
        translated.code += ignore + statementTerminator;
      }
      return translated;
    },
    tests: []
  },
  ForStatement: {
    translate: function(code, node) {
      var translated = {};
      translated.code =
        node.init.translate().code +
        'while (' + boolWrapper + '(' + node.test.translate().code + ')) {\n' +
        node.body.translate().code + ' |> ignore' + statementTerminator +
        node.update.translate().code + statementTerminator +
        '}' + statementTerminator;
      return translated;
    },
    tests: []
  },
  ForOfStatement: defaultBody,
  ForInStatement: defaultBody,
  FunctionDeclaration: {
    translate: function(code, node) {
      var translated = {};
      var retType = node[globalTypeName].replace(/.*=> /, '');
      var ignoreReturn = false;
      if (retType === 'unit') {
        ignoreReturn = true;
      }
      translated.code =
        'let ' + node.id.translate().code +
        ' = (' + joinParams(node) + ') => ' +
        '{\n' +
        node.body.translate().code + statementTerminator +
        (ignoreReturn ? '()' : '') +
        '}\n' + statementTerminator;
      return translated;
    },
    tests: []
  },
  FunctionExpression: {
    translate: function(code, node) {
      var translated = {};
      var retType = node[globalTypeName].replace(/.*=> /, '');
      var ignoreReturn = false;
      if (retType == 'unit') {
        ignoreReturn = true;
      }
      translated.code =
        '(' + joinParams(node) + ') => ' + node.body.translate().code +
        (ignoreReturn ? ' |> ignore' : '');
      return translated;
    },
    tests: []
  },
  Identifier: {
    translate: function(code, node) {
      var translated = {};
      if (node.name in globalsMap) {
        var externName = node.name.toLowerCase();
        var attributes = ['[@bs.val]'];
        var argTypes = ['unit'];
        var retType = node[globalTypeName];
        var callName = node.name;
        state.reasonExterns[externName] = {
          noargs: true,
          attributes: attributes,
          argTypes: argTypes,
          retType: retType,
          callName: callName
        };
        translated.code = externName;
      } else {
        var parentNode = state.astNodeParents[node[globalIndexName]];
        var name = node.name;
        var deref = '^';
        var mutable = isMutable(code, node);
        if ((parentNode.type == 'VariableDeclarator' &&
             parentNode.id[globalIndexName] == node[globalIndexName]) ||
            (parentNode.type == 'AssignmentExpression' &&
             parentNode.left[globalIndexName] == node[globalIndexName]) ||
            parentNode.type == 'UpdateExpression') {
          deref = '';
        }
        /* TODO: optimize with dict */
        if (reserved.includes(name)) {
          name = name + '_';
        }
        if (mutable) {
          translated.code = name + 'Ref' + deref;
        } else {
          translated.code = name;
        }
      };
      return translated;
    },
    tests: []
  },
  IfStatement: {
    translate: function(code, node) {
      var translated = {};
      var first = node.test.translate().code;
      var second = node.consequent.translate().code;
      var third = node.alternate.translate().code;
      if (node.consequent[globalTypeName] != node.alternate[globalTypeName]) {
        if (node.consequent[globalTypeName] == 'string' && node.alternate[globalTypeName] == 'int') {
          third = 'string_of_int(' + third + ')';
        }
      }
      if (third !== null) {
        translated.code = 
          'if (' + boolWrapper + '(' + first + ')) ' + second + 
          ' else ' + third + statementTerminator;
      } else {
        translated.code = 
          'if (' + boolWrapper + '(' + first + ')) ' + second + statementTerminator;
      }
      return translated;
    },
    tests: [
      {
        program: 'if (true) { ' + test.statement1 + ' } else { ' + test.statement2 + '}',
        out: [test.out1]
      },
      {
        program: 'if (false) { ' + test.statement1 + ' } else { ' + test.statement2 + '}',
        out: [test.out2]
      }
    ]
  },
  Import: defaultBody,
  ImportDeclaration: defaultBody,
  ImportDefaultSpecifier: defaultBody,
  ImportNamespaceSpecifier: defaultBody,
  ImportSpecifier: defaultBody,
  Literal: {
    translate: function(code, node) {
      var translated = {};
      if (node[globalTypeName] == 'string') {
        translated.code = '"' + node.value + '"';
      } else if (node[globalTypeName] === boolType) {
        if (useBoolWrapper && node.raw === 'true') {
          translated.code = 'Js.true_';
        } else if (useBoolWrapper && node.raw === 'false') {
          translated.code = 'Js.false_';
        } else {
          translated.code = node.raw;
        }
      } else if (node.raw === 'null') {
        translated.code = 'Js.Nullable.null';
      } else {
        translated.code = node.raw;
      }
      return translated;
    },
    tests: []
  },
  LabeledStatement: defaultBody,
  LogicalExpression: {
    translate: function(code, node) {
      var translated = {};
      var operator = node.operator;
      var left = node.left.translate().code;
      var right = node.right.translate().code;
      translated.code = '(' + left + ' ' + operator + ' ' + right + ')';
      return translated;
    },
    tests: []
  },
  MemberExpression: defaultBody,
  MemberExpression: {
    translate: function(code, node) {
      var translated = {};
      var parentNode = state.astNodeParents[node[globalIndexName]];
      var useRight = null;
      var qual = '';
      var translated = {};
      if (parentNode.type == 'AssignmentExpression' &&
          parentNode.left[globalIndexName] == node[globalIndexName]) {
        qual = 'set';
        var externName = qual + getExternName(code, node);
        var attributes = ['[@bs.set]'];
        var argTypes = [node.object[globalTypeName], parentNode.right[globalTypeName]];
        /*
        var retType = parentNode[globalTypeName];
        */
        var retType = 'unit';
        var callName = node.property.name;
        if (node.computed) {
          attributes = ['[@bs.set_index]'];
          callName = '';
        }
        var value = {
          attributes: attributes,
          argTypes: argTypes,
          retType: retType,
          callName: callName
        };
        externName = addExtern(externName, value);
        translated.codeSet = externName;
        translated.codeLeft = node.object.translate().code;
        useRight = parentNode.right[globalTypeName];
      }
      var retType = node[globalTypeName];
      if (retType === undefined) {
        if (useRight !== null) {
          retType = useRight;
        } else {
          var msg = 'Unresolved MemberExpression';
          showNodeError(code, node, msg);
          throw new Error(msg);
        };
      };
      qual = 'get';
      var [parts, modName, modResolved] = getModName(code, node);
      var externName = qual + getExternName(code, node);
      var attributes = ['[@bs.get]'];
      var callName = node.property.name;
      var argTypes = [node.object[globalTypeName]];
      if (node.computed) {
        attributes = ['[@bs.get_index]'];
        callName = '';
        argTypes.push(node.property[globalTypeName]);
      } else {
        if (modName !== null && modName in modMap) {
          attributes = ['[@bs.val]'];
        } else {
          modName = null;
        }
      }
      var value = {
        attributes: attributes,
        argTypes: argTypes,
        retType: retType,
        callName: callName
      };
      if (modName !== null) {
        value.noargs = true;
        attributes.push('[@bs.module "' + modResolved + '"]');
        if (parts.length > 2) {
          for (var i = 1; i < parts.length - 1; i++) {
            attributes.push('[@bs.scope "' + parts[i] + '"]');
          }
        }
      }
      externName = addExtern(externName, value);
      if (modName !== null) {
        translated.code = externName;
      } else {
        /*
        translated.code = externName + '(' + node.object.translate().code + ')';
        */
        if (!node.computed) {
          translated.code = '(' + node.object.translate().code + ' |. ' + externName + ')';
        } else {
          translated.code =
            '(' + node.object.translate().code + ' |. ' + externName +
            '(' + node.property.translate().code + ')' + ')';
        }
      }
      return translated;
    },
    tests: [],
  },
  MetaProperty: defaultBody,
  MethodDefinition: defaultBody,
  NewExpression: {
    translate: function(code, node) {
      return applyExpression({
          type: 'new',
          attributes: ['[@bs.new]']
        },
        code,
        node);
    },
    tests: []
  },
  ObjectExpression: {
    translate: function(code, node) {
      var translated = {};
      var rml = [];
      for (var i = 0; i < node.properties.length; i++) {
        var prop = node.properties[i];
        var name = prop.key.name;
        var value = prop.value;
        rml.push('"' + name + '": ' + value.translate().code + '\n');
      };
      translated.code = '{' + rml.join(',') + '}';
      return translated;
    },
    tests: []
  },
  ObjectPattern: defaultBody,
  Program: {
    translate: function(code, node) {
      var translated = {};
      var rml = [];
      for (var i = 0; i < node.body.length; i++) {
        var child = node.body[i];
        rml.push(child.translate().code);
      }
      translated.code = rml.join('\n');
      return translated;
    },
    tests: [
      {
        program: test.statement1,
        out: [test.out1]
      },
      {
        program: test.statement2,
        out: [test.out2]
      }
    ]
  },
  Property: {
    translate: function(code, node) {
      throw new Error("Property should be processed by ObjectExpression.");
    },
    tests: []
  },
  RestElement: defaultBody,
  ReturnStatement: {
    translate: function(code, node) {
      var translated = {};
      translated.code = node.argument.translate().code;
      return translated;
    },
    tests: []
  },
  SequenceExpression: defaultBody,
  SpreadElement: defaultBody,
  Super: defaultBody,
  SwitchCase: defaultBody,
  SwitchStatement: defaultBody,
  TaggedTemplateExpression: defaultBody,
  TemplateElement: defaultBody,
  TemplateLiteral: defaultBody,
  ThisExpression: defaultBody,
  ThrowStatement: defaultBody,
  TryStatement: defaultBody,
  UnaryExpression: {
    translate: function(code, node) {
      var translated = {};
      if (node.prefix != true) {
        throw(new Error('suffix unary operator not implemented'));
      }
      if (node.operator == '+') {
        translated.code = '(+ ' + node.argument.translate().code + ')';
      } else if (node.operator == '-') {
        translated.code = '(- ' + node.argument.translate().code + ')';
      } else {
        throw(new Error('prefix unary operator not implemented: ' + node.operator));
      }
      return translated;
    },
    tests: [],
  },
  UpdateExpression: {
    translate: function(code, node) {
      var translated = {};
      if (node.prefix == true) {
        throw(new Error('prefix operator not implemented'));
      }
      if (node.operator == '++') {
        translated.code = '' + node.argument.translate().code + ' := ' + node.argument.translate().code + '^ + 1';
      } else if (node.operator == '--') {
        translated.code = '' + node.argument.translate().code + ' := ' + node.argument.translate().code + '^ - 1';
      } else {
        throw(new Error('suffix operator not implemented: ' + node.operator));
      }
      return translated;
    },
    tests: []
  },
  VariableDeclaration: {
    translate: function(code, node) {
      var translated = {};
      var rml = [];
      /*
      var rmla = [];
      */
      var parentNode = state.astNodeParents[node[globalIndexName]];
      for (var i = 0; i < node.declarations.length; i++) {
        var name = node.declarations[i].id.translate().code;
        var mutable = isMutable(code, node.declarations[i].id);
        var value = null;
        if (node.declarations[i].init != null) {
          value = node.declarations[i].init.translate().code;
        } else {
          value = '/* TODO: Uninitialized var */ 0';
          mutable = true;
        };

        if (mutable) {
          value = 'ref(' + value + ')';
        }
        var s = 'let ' + name + ' = ' + value;
        if (!s.trim().endsWith(';')) {
          s += statementTerminator;
        }
        var isRequire = value.startsWith('require(');
        if (isRequire) {
          /* TODO: a bit hacky. only supports var lib = require("string"); */
          modMap[name] = node.declarations[i].init.arguments[0].value;
        } else {
          rml.push(s);
        }
      }
      translated.code = rml.join('\n');
      return translated;
    },
    tests: []
  },
  VariableDeclarator: {
    translate: function(code, node) {
      throw new Error("VariableDeclarator should be processed by VariableDeclaration.");
    },
    tests: []
  },
  WhileStatement: defaultBody,
  WithStatement: defaultBody,
  YieldExpression: defaultBody
};

/* Comment nodes */
processNodes.Block = {
  translate: function(code, node) {
    throw new Error("Comments processed elsewhere.");
  },
  tests: []
};

processNodes.Line = {
  translate: function(code, node) {
    throw new Error("Comments processed elsewhere.");
  },
  tests: []
};

export var tests = {};
for (var name in processNodes) {
  var processNode = node(processNodes[name]);
  processNode.name = name;
  processNodes[name] = processNode;
  for (var i = 0; i < processNode.tests.length; i++) {
    tests[name + i.toString()] = processNode.tests[i];
  }
}

var getTranslate = function(code, node, translate) {
  return function() {
    var retval = translate(code, node);
    if (!('code' in retval)) {
      console.log('error node', node);
      throw new Error('no code returned for node: ' + node.type);
    }
    if ('leadingComments' in node) {
      var comment = []
      for (var i = 0; i < node.leadingComments.length; i++) {
        comment.push(node.leadingComments[i].value);
      }
      comment = comment.join('\n');
      retval.code = '/*' + comment + ' */' + '\n' + retval.code;
    }
    return retval;
  };
};

function postProcess(code, parentNode, node) {
  if (node.type in processNodes) {
    var translate = getTranslate(code, node, processNodes[node.type].translate);
    node.translate = lazy(translate);
  } else {
    throw(new Error('unimplemented node type: ' + node.type + ', parent: ' + parentNode.type));
  };
  return node;
};

function checkTypeCount(index) {
  var oldValue = !(index in state.astNodeTypeUnresolved);
  delete state.astNodeTypeUnresolved[index];
  var remaining = Object.keys(state.astNodeTypeUnresolved).length;
  if (!oldValue) {
    /*
    consoleLog("Remaining types to resolve: ", remaining);
    */
    for (var i = 0; i < showTypesCallbacks.length; i++) {
      showTypesCallbacks[i](state.astNodeTypeUnresolved);
    }
  }
  if (remaining == 0) {
    state.astResolve();
  }
};

function U(index, arg) {
  checkTypeCount(index);
  var node = state.astNodes[index];
  if (node.type == 'AssignmentExpression' && node.left.type == 'Identifier') {
    state.astMutables[node.left.name] = true;
  }
  if (node.type == 'UpdateExpression' && node.argument.type == 'Identifier') {
    state.astMutables[node.argument.name] = true;
  }
  var newType = getType(arg, node);
  /*
  (node[globalTypeName].match(/float/g) || []).length;
  */
  if (globalTypeName in node && node[globalTypeName].replace(/float/g, 'int') === newType) {
    // unify int and float to float
  } else {
    node[globalTypeName] = newType;
  }
  state.astNodeObjects[index] = arg;
  state.astNodesDebug[index] = arg;
  return arg;
};

function F(index, args, f) {
  checkTypeCount(index);
  var retval = f(...args);
  var node = state.astNodes[index];
  var parentNode = state.astNodeParents[node[globalIndexName]];
  var parameters = parentNode.params;
  var argTypes = [];
  for (var i = 0; i < args.length; i++) {
    var param = parameters[i];
    if (param === undefined) {
      continue;
      /*
      param = parentNode;
      */
    }
    argTypes.push(getType(args[i], param));
  }
  var retType = getType(retval, parentNode);
  var argTypesStr = '(' + argTypes.join(', ') + ')';
  if (argTypes.length == 0) {
    argTypesStr = 'unit';
  }
  var funType = argTypesStr + ' => ' + retType;
  if (parentNode.id != null) {
    /* Named function */
    var funTypeName = 'usageFun' + capitalizeFirstLetter(parentNode.id.name) + 'T';
    if (!(funTypeName in state.reasonTypes)) {
      state.reasonTypes[funTypeName] = {};
    }
    state.reasonTypes[funTypeName].decl = funType;
  } else {
    /* Anonymous function */
    // Update all AST node types which have an object reference to the function
    var parentIndex = parentNode[globalIndexName];
    /* TODO: optimize */
    for (var i = 0; i < state.astNodeObjects.length; i++) {
      if (i != parentIndex && state.astNodeObjects[i] === state.astNodeObjects[parentIndex]) {
        var node = state.astNodes[i];
        if (node.type == 'Identifier') {
          var funTypeName = 'usageFun' + capitalizeFirstLetter(node.name) + 'T';
          if (!(funTypeName in state.reasonTypes)) {
            state.reasonTypes[funTypeName] = {};
          }
          state.reasonTypes[funTypeName].decl = funType;
        }
      }
    }
  }
  parentNode[globalTypeName] = funType;
  return retval;
};

function getNodePath(node, f) {
  var path = [];
  while (state.astNodeParents[node[globalIndexName]] != null) {
    path.push(node);
    node = state.astNodeParents[node[globalIndexName]];
  }
  path.push(node);
  return path.reverse();
}

function checkNodePath(node, f) {
  while (state.astNodeParents[node[globalIndexName]] != null) {
    if (f(node)) {
      return true;
    };
    node = state.astNodeParents[node[globalIndexName]];
  }
  if (f(node)) {
    return true;
  };
  return false;
}

function postProcessTypes(code, parentNode, node) {
  var directIgnores = {
    'VariableDeclaration': {},
    'FunctionDeclaration': {},
    'ExpressionStatement': {},
    /* 'AssignmentExpression': {}, */
    'Program': {},
    'Property': {},
    'Line': {},
    'Block': {},
    'BlockStatement': {},
    'ReturnStatement': {},
    'ForStatement': {},
    'IfStatement': {},
    'SpreadElement': {}
  };
  var checkIt = function(ignores, propName) {
    var f = function(node) {
      return node.type in ignores;
    };
    var g = function(node) {
      var parentNode = state.astNodeParents[node[globalIndexName]];
      if (parentNode != null) {
        if (propName in parentNode && parentNode[propName] !== null) {
          if (node[globalIndexName] === parentNode[propName][globalIndexName]) {
            return true;
          }
          if (Array.isArray(parentNode[propName])) {
            for (var i = 0; i < parentNode[propName].length; i++) {
              var pNode = parentNode[propName][i];
              if (node[globalIndexName] === pNode[globalIndexName]) {
                return true;
              }
            }
          }
        }
      };
      return false;
    };
    var done = false;
    var h = function(node) {
      if (done) {
        return false;
      };
      if (g(node)) {
        done = true;
        return false;
      };
      return f(node);
    };
    return checkNodePath(node, h);
  };
  var checkNodeParent = function(node, parentType, prop, extraCheck) {
    if (extraCheck === undefined) {
      extraCheck = function() { return true; };
    }
    var parentNode = state.astNodeParents[node[globalIndexName]];
    if (parentNode != null && extraCheck(parentNode)) {
      if (parentNode.type == parentType) {
        if (prop in parentNode) {
          if (parentNode[prop][globalIndexName] === node[globalIndexName]) {
            return true;
          }
          if (Array.isArray(parentNode[prop])) {
            for (var i = 0; i < parentNode[prop].length; i++) {
              var pNode = parentNode[prop][i];
              if (node[globalIndexName] === pNode[globalIndexName]) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  };
  var checkNodeParentAssign = function(node) {
    return checkNodeParent(node, 'AssignmentExpression', 'left');
  };
  var checkNodeParentMemberProperty = function(node) {
    return checkNodeParent(node, 'MemberExpression', 'property', function(node) {
      return !node.computed;
    });
  };
  var checkNodeParentCallCallee = function(node) {
    return checkNodeParent(node, 'CallExpression', 'callee');
  };
  var checkNodeParentFunctionId = function(node) {
    return checkNodeParent(node, 'FunctionDeclaration', 'id');
  };
  var checkNodeParentFunctionArguments = function(node) {
    var a = checkNodeParent(node, 'FunctionDeclaration', 'params');
    var b = checkNodeParent(node, 'FunctionExpression', 'params');
    return a || b;
  };
  var checkNodeParentUpdate = function(node) {
    return checkNodeParent(node, 'UpdateExpression', 'argument');
  };
  var isVarDecl = checkIt({ 'VariableDeclarator': {} }, 'init');
  var isObjKey = checkIt({ 'Property': {} }, 'value');
  var isFunDecl = checkIt({ 'FunctionDeclaration': {} }, 'body');
  var isNewCallee = checkIt({ 'NewExpression': {} }, 'arguments') && node.type != 'NewExpression';
  var isAssign = checkNodeParentAssign(node);
  /*
  onsoleLog(
    node.type,
    getCode(code, node),
    !(node.type in directIgnores),
    !isVarDecl,
    !isObjKey,
    !isFunDecl,
    !isNewCallee,
    !isAssign,
    !checkNodeParentMemberProperty(node),
    !checkNodeParentCallCallee(node),
    !checkNodeParentFunctionId(node),
    !checkNodeParentFunctionArguments(node),
    !checkNodeParentUpdate(node));
    */
  if (!(node.type in directIgnores) &&
      !isVarDecl &&
      !isObjKey &&
      !isFunDecl &&
      !isNewCallee &&
      !isAssign &&
      !checkNodeParentMemberProperty(node) &&
      !checkNodeParentCallCallee(node) &&
      !checkNodeParentFunctionId(node) &&
      !checkNodeParentFunctionArguments(node) &&
      !checkNodeParentUpdate(node)) {
    var expr = 'U(' + node[globalIndexName] + ', arg)';
    var newNode = getExpression(expr);
    newNode.arguments[1] = node;
    newNode.isU = true;
    state.astTypeCount++;
    state.astNodeTypeUnresolved[node[globalIndexName]] = node;
    return newNode;
  }
  var checkNodeParentFunctionDeclBody = function(node) {
    var a = checkNodeParent(node, 'FunctionDeclaration', 'body');
    return a;
  };
  var checkNodeParentFunctionExprBody = function(node) {
    var b = checkNodeParent(node, 'FunctionExpression', 'body');
    return b;
  };
  var isFunBody = checkNodeParentFunctionDeclBody(node);
  var isFunExprBody = checkNodeParentFunctionExprBody(node);
  if (isFunBody || isFunExprBody) {
    var expr = '() => { return F(' + node[globalIndexName] + ', arguments, function() {}); }';
    var newNode = esprima.parse(expr).body[0].expression.body;
    newNode.isU = true;
    newNode.body[0].argument.arguments[2].body = node;
    state.astTypeCount++;
    state.astNodeTypeUnresolved[node[globalIndexName]] = node;
    return newNode;
  };
  if (node.type == 'IfStatement' && enableAllIfBranches[0]) {
    /* WARNING: All branches of if statement are executed to get the types */
    var expr = '{}';
    var newNode = esprima.parse(expr).body[0];
    newNode.isU = true;
    newNode.body = [node.test, node.consequent];
    if (node.alternate !== null) {
      newNode.body.push(node.alternate);
    }
    return newNode;
  }
  return node;
};

function postProcessTypesAdd(code, parentNode, node) {
  node[globalIndexName] = state.astNodes.length;
  state.astNodes.push(node);
  state.astNodeParents[node[globalIndexName]] = parentNode;
  return node;
};

function walk(code, parentNode, node, postProcess) {
  if (node !== null && node !== undefined && node.hasOwnProperty('type')) {
    var newNode = {};
    for (var prop in node) {
      var value = node[prop];
      var newValue;
      if (node.type == "Program" && prop == 'tokens') {
        /* Don't process the raw tokens, only AST */
        newValue = value;
      } else if (Array.isArray(value)) {
        newValue = [];
        for (var i = 0; i < value.length; i++) {
          newValue.push(walk(code, newNode, value[i], postProcess));
        }
      } else {
        newValue = walk(code, newNode, value, postProcess);
      }
      newNode[prop] = newValue;
    }
    node = postProcess(code, parentNode, newNode);
  }
  return node;
};

function rewrite(code, ast, postProcess) {
  return walk(code, null, ast, postProcess);
};

function declareTypes(body, externs, firstGenTypes) {
  var types = [];
  /*
   * Fake topological sort :p
   * Pass 0: types without declaration
   * Pass 1: types with declaration, but no functions
   * Pass 2: types with declaration, only functions
   * TODO: Real topological sort.
   * */
  for (var pass = 0; pass < 3; pass++) {
    for (var name in state.reasonTypes) {
      var value = state.reasonTypes[name];
      if ('decl' in value) {
        var isFunction = value.decl.includes('=>');
        if (!isFunction) {
          if (pass != 1) {
            continue;
          }
        } else {
          if (pass != 2) {
            continue;
          }
        }
        value = value.decl;
      } else {
        if (pass != 0) {
          continue;
        }
        value = '';
      };
      var s;
      if (value != '') {
        s = 'type ' + name + ' = ' + value + ';';
      } else {
        s = 'type ' + name + ';';
      }
      /* Only list types that are used */
      if (body.includes(name) || externs.includes(name) || firstGenTypes.includes(name)) {
        types.push(s);
      } else {
        // types.push('/* /* Unused type: */ ' + s + ' */');
      };
    };
  }
  return types;
};

function declareExtern(name, value) {
  if ('isNotExtern' in value && value.isNotExtern) {
    return null;
  };
  var noargs = 'noargs' in value;
  var retType = value.retType;
  var typesig;
  if (noargs) {
    typesig = retType;
  } else {
    if (value.argTypes.length == 0) {
      typesig = 'unit => ' + retType;
    } else {
      typesig = '(' + value.argTypes.join(', ') + ') => ' + retType;
    }
  };
  var callName = value.callName;
  var s =
    value.attributes.join(' ') +
    ' external ' +
    name +
    ' : ' +
    typesig +
    ' = "' + callName + '";';
  return s;
}

function declareExterns() {
  var externs = [];
  for (var name in state.reasonExterns) {
    var value = state.reasonExterns[name];
    var s = declareExtern(name, value);
    if (s != null) {
      externs.push(s);
    }
  }
  return externs;
}

export function compileAST(data) {
  var syntax;
  if (!useFlow[0]) {
    syntax =
      esprima.parse(
        data,
        { raw: true, tokens: true, range: true, comment: true });

    syntax = escodegen.attachComments(syntax, syntax.comments, syntax.tokens);
  } else {
    syntax = flow.parse('// @flow\n\n' + data);
  }

  var debugU = true;
  if (debugU) {
    syntax = rewrite(data, syntax, postProcessTypesAdd);

    syntax = rewrite(data, syntax, postProcessTypes);
  }

  state = initState(data);

  var nodePaths = [];

  function postProcessAST(code, path, value, node) {
    nodePaths.push(path.join('/') + ' = ' + value);
  };

  function walk(code, path, name, node, postProcess) {
    path.push(name);
    if (node !== null && node !== undefined && typeof(node) == 'object') {
      var newNode = {};
      for (var prop in node) {
        var value = node[prop];
        var newValue;
        if (Array.isArray(value)) {
          newValue = [];
          for (var i = 0; i < value.length; i++) {
            var name = prop + '[' + i + ']';
            newValue.push(walk(code, path, name, value[i], postProcess));
          }
        } else {
          var name = prop;
          newValue = walk(code, path, name, value, postProcess);
        }
        newNode[prop] = newValue;
      }
    } else {
      var value = JSON.stringify(node);
      postProcess(code, path, value, newNode);
    }
    path.pop();
  };

  syntax.tokens = [];

  walk(data, [], '', syntax, postProcessAST);

  var s = nodePaths.join('\n');
  return s;
}

var showTypesCallbacks = [];
export function registerShowTypesCallback(f) {
  showTypesCallbacks.push(f);
}

export function compile(data, evalTimeout) {
  var syntax =
    esprima.parse(
      data,
      { raw: true, tokens: true, range: true, comment: true });

  syntax = escodegen.attachComments(syntax, syntax.comments, syntax.tokens);

  state = initState(data);

  var syntax2 = rewrite(data, syntax, postProcessTypesAdd);

  var syntaxForTypes = rewrite(data, syntax2, postProcessTypes);
  var indent = '  ';
  var quotes = 'auto';
  var option = {
      comment: true,
      format: {
          indent: {
              style: indent
          },
          quotes: quotes
      }
  };

  var code = escodegen.generate(syntaxForTypes, option);

  eval(code);

  var timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(function() {
        reject(new Error('timeout for resolving all types'))
      },
      evalTimeout);
  });

  var afterEval = function() {
    var syntaxReasonML = rewrite(data, syntax2, postProcess);

    var reasonmlCode = syntaxReasonML.translate().code;

    var decl = declareExterns().join('\n');

    var types = declareTypes(reasonmlCode, decl, '');

    /* TODO: do recursive lookup of types instead of just 2 steps */
    var types2 = declareTypes(reasonmlCode, decl, types.join('\n'));

    var header = types2.join('\n') + '\n' + decl;

    var body = reasonmlCode;

    var program = header + '\n' + body;

    return program;
  };

  return Promise.race([timeoutPromise, state.astTypesResolvedPromise]).then(afterEval);
};

/*
module.exports = {
  compileAST: compileAST,
  compile: compile
};
*/
