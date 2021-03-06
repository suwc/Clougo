//-------------------------------------------------------------------------------------------------------
// Copyright (C) Clougo Project. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//-------------------------------------------------------------------------------------------------------

// Transpiles parsed Logo code into JavaScript
// Runs in browser's Logo worker thread or Node's main thread

"use strict";

var $classObj = {};
$classObj.create = function(logo, sys) {

    const defaultInstrListName = "[]";

    const codegen = {};

    let _funcName = "";

    let _isLambda = false;

    const _varScopes = (() => {
        let self = {};

        let localVarStack = [];
        let nonGlobalVar = {};

        function enter() {
            localVarStack.push({});
        }
        self.enter = enter;

        function exit() {
            localVarStack.pop();
        }
        self.exit = exit;

        function addVar(varName) {
            scope()[varName] = 1;
            nonGlobalVar[varName] = 1;
        }
        self.addVar = addVar;

        function isLocalVar(varName) {
            return varName in scope();
        }
        self.isLocalVar = isLocalVar;

        function isGlobalVar(varName) {
            return !(varName in nonGlobalVar);
        }
        self.isGlobalVar = isGlobalVar;

        function localVars() {
            return Object.keys(scope());
        }
        self.localVars = localVars;

        function scope() {
            return localVarStack[localVarStack.length - 1];
        }

        return self;
    })();

    const genNativeJs = {
        "if": genIf,
        "catch": genCatch,
        "ifelse": genIfElse,
        "make": genMake,
        "localmake": genLocalmake,
        "local": genLocal,
        "repeat": genRepeat,
        "for": genFor,
        "pi": genPi
    };

    const genLambda = {
        "apply": 1
    };

    const CODE_TYPE = {
        EXPR: 0,
        STMT: 1
    };

    class Code {
        constructor(rawCodeArray, codeType) {
            this._code = rawCodeArray.slice(0);
            this._codeType = codeType;
            this._postFix = false;
        }

        static expr(...rawCode) {
            return new Code(rawCode, CODE_TYPE.EXPR);
        }

        static stmt(...rawCode) {
            return new Code(rawCode, CODE_TYPE.STMT);
        }

        append(...args) {
            Array.prototype.push.apply(this._code, args);
            if (containsPostFix(args)) {
                this._postFix = true;
            }

            return this;
        }

        prepend(...args) {
            args.splice(0, 0, 0, 0);
            Array.prototype.splice.apply(this._code, args);
            if (containsPostFix(args)) {
                this._postFix = true;
            }

            return this;
        }

        captureRetVal() {
            return this.prepend("$ret=");
        }

        length() {
            return this._code.length;
        }

        isExpr() {
            return this._codeType === CODE_TYPE.EXPR;
        }

        postFix() {
            return this._postFix;
        }

        merge() {
            return this._code.map((v) => (v instanceof Code) ? v.merge() :
                typeof v !== "string" ? JSON.stringify(v) : v).join("");
        }

        withPostFix(postFix) {
            this._postFix = postFix;
            return this;
        }

        last() {
            return this._code.length > 0 ? this._code[this._code.length - 1] : undefined;
        }

        appendBinaryOperatorExprs(evxContext, precedence) {
            while (evxContext.isNextTokenBinaryOperator() &&
                precedence < logo.lrt.util.getBinaryOperatorPrecedence(evxContext.getNextOperator())) {

                this.appendNextBinaryOperatorExpr(evxContext);
            }

            return this;
        }

        appendNextBinaryOperatorExpr(evxContext) {
            let nextOp = evxContext.getNextOperator();
            let nextOpSrcmap = evxContext.getNextOperatorSrcmap();
            let nextPrec = logo.lrt.util.getBinaryOperatorPrecedence(nextOp);

            let nextOpnd = genProcInput(evxContext.next().next(), nextPrec, false, nextOp);
            let lastOpnd = this.last();
            let postfix = sys.Config.get("postfix") ||
                ((lastOpnd instanceof Code) && lastOpnd.postFix()) || nextOpnd.postFix();

            return !postfix ? this.appendInfixBinaryOperatorExpr(nextOp, nextOpnd, nextOpSrcmap) :
                this.appendPostfixBinaryOperatorExpr(nextOp, nextOpnd, nextOpSrcmap);
        }

        appendInfixBinaryOperatorExpr(nextOp, nextOpnd, nextOpSrcmap) {
            return this.prepend("(\"", nextOp,  "\",", logo.type.srcmapToJs(nextOpSrcmap), ",")
                .prepend(genCallPrimitiveOperator())
                .prepend("($ret=")
                .append(",")
                .append(nextOpnd)
                .append("))");
        }

        appendPostfixBinaryOperatorExpr(nextOp, nextOpnd, nextOpSrcmap) {
            return this.withPostFix(true)
                .prepend("$param.begin([\"", nextOp, "\",", logo.type.srcmapToJs(nextOpSrcmap), "]);\n")
                .append(";\n$param.add($ret);\n")
                .append(nextOpnd)
                .append(";\n$param.add($ret);\n")
                .append("$ret=")
                .append(genCallPrimitiveOperator())
                .append(".apply(undefined,$param.end());\n");
        }
    }

    const CODEGEN_CONSTANTS = {
        NOP: Code.stmt("undefined;")
    };

    function genPi() {
        return Code.expr("Math.PI");
    }

    function genLocal(evxContext, isInParen = false) {

        let code = Code.stmt();

        code.append("let ");

        let expectedParams = 1;
        let generatedParams = 0;
        let varName;

        while ((generatedParams < expectedParams || isInParen) && evxContext.peekNextToken() != ")" &&
            evxContext.hasNext()) {

            varName = evxContext.next().getToken();
            if (generatedParams > 0) {
                code.append(",");
            }

            sys.assert(logo.type.isQuotedLogoWord(varName));  // TODO: throw Logo exception
            varName = logo.type.unquoteLogoWord(varName).toLowerCase();
            _varScopes.addVar(varName);
            code.append(varName);

            generatedParams++;
        }

        code.append(";");
        sys.trace("VARNAME=" + varName, "codegen.genLocal");

        return code;
    }

    function genInstrList(evxContext, primitiveName, generateCheckUnactionableDatum = true) {
        let code = Code.expr();

        let curToken = evxContext.getToken();
        let srcmap = evxContext.getSrcmap();

        if (evxContext.isTokenEndOfStatement(curToken)) {
            code.append(genThrowNotEnoughInputs(evxContext.getSrcmap(), primitiveName));
        } else if (logo.type.isLogoList(curToken)) {
            let comp = logo.parse.parseBlock(logo.type.embedSrcmap(curToken, srcmap));
            code.append(genBody(logo.interpreter.makeEvalContext(comp)));
        } else {
            code.append(genInstrListCall(curToken, srcmap));
        }

        if (generateCheckUnactionableDatum && sys.Config.get("unactionableDatum")) {
            code.append(";checkUnactionableDatum($ret,", logo.type.srcmapToJs(srcmap), ");\n");
        }

        return code;
    }

    function genIf(evxContext) {
        let code = Code.stmt();

        code.append(genToken(evxContext.next()));
        code.append(";\n");
        code.append("if (logo.type.isNotLogoFalse($ret)) {\n");

        code.append(genInstrList(evxContext.next(), "if"));
        code.append("}");

        if (evxContext.peekNextToken() === "else") {
            code.append(" else {");
            code.append(genInstrList(evxContext.next().next(), "if"));
            code.append("}");
        }

        code.append("\n;$ret=undefined;");

        return code;
    }

    function genCatch(evxContext) {
        let code = Code.stmt();
        let label = genToken(evxContext.next());

        code.append("try {\n");

        code.append(genInstrList(evxContext.next(), "catch", false));
        code.append("} catch (e) {\n");

        code.append("if (e.isCustom()) {\n");
        code.append("if (sys.equalToken(");
        code.append(label);
        code.append(", e.getValue()[0])){$ret=e.getValue()[1];}\n");
        code.append("else { throw e;} }\n");

        code.append("else if (!logo.type.LogoException.is(e) || (e.isError() && !sys.equalToken(");
        code.append(label);
        code.append(", 'error'))) {\n");
        code.append("throw e;}else{$ret=undefined;}}\n");

        code.append("if($ret !== undefined) return $ret\n");

        return code;
    }

    function genIfElse(evxContext) {
        let code = Code.stmt();

        code.append(genToken(evxContext.next()));
        code.append(";\n");
        code.append("if (logo.type.isNotLogoFalse($ret)) {\n");
        code.append(genInstrList(evxContext.next(), "ifelse"));
        code.append("} else {\n");
        code.append(genInstrList(evxContext.next(), "ifelse"));

        code.append("}");
        code.append("\n;$ret=undefined;");

        return code;
    }

    function genRepeat(evxContext) {
        let code = Code.stmt();
        let repeatVarName = "$i";

        code.append(genToken(evxContext.next()));
        code.append(";const $repeatEnd=$ret;\n");
        code.append("for (let ");
        code.append(repeatVarName, "=0;", repeatVarName, "<$repeatEnd;", repeatVarName, "++) {\n");
        code.append(genInstrList(evxContext.next(), "repeat"));
        code.append("}");
        code.append("\n;$ret=undefined;");

        return code;
    }

    function genFor(evxContext) {
        let code = Code.stmt();

        let token = evxContext.next().getToken();
        let srcmap = evxContext.getSrcmap();

        token = token.map(sys.toNumberIfApplicable);

        let comp = logo.parse.parseBlock(logo.type.embedSrcmap(token, srcmap));
        let forLoopCtrl = logo.interpreter.makeEvalContext(comp);
        let forVarName = genLogoVarLref(forLoopCtrl.getToken());

        code.append("{");
        code.append(genToken(forLoopCtrl.next()));
        code.append(";const $forBegin=$ret;\n");

        code.append(genToken(forLoopCtrl.next()));
        code.append(";const $forEnd=$ret;\n");

        code.append("const $forDecrease = $forEnd < $forBegin;\n");

        let forStep = forLoopCtrl.hasNext() ? genToken(forLoopCtrl.next()) : "$forDecrease ? -1 : 1";
        code.append("const $forStep = ", forStep, ";\n");

        code.append("if ((!$forDecrease && $forStep > 0) || ($forDecrease && $forStep < 0))\n");
        code.append("for(", forVarName, "=$forBegin; ($forDecrease && ", forVarName, ">=$forEnd) || (!$forDecrease &&",
            forVarName, "<=$forEnd); ", forVarName, "+=$forStep) {\n");

        code.append(genInstrList(evxContext.next(), "for"));

        code.append("}}");
        code.append("\n;$ret=undefined;");

        return code;
    }

    function genMake(evxContext) {
        let code = Code.stmt();
        let varName = logo.env.extractVarName(evxContext.next().getToken());

        code.append(genToken(evxContext.next()));
        code.append(";\n");
        code.append(genLogoVarLref(varName));
        code.append("=$ret;$ret=undefined;");

        return code;
    }

    function genLocalmake(evxContext) {
        let varName = logo.env.extractVarName(evxContext.next().getToken());
        _varScopes.addVar(varName);

        return Code.stmt()
            .append(genToken(evxContext.next()))
            .append(";\n")
            .append("let ")
            .append(genLogoVarLref(varName))
            .append("=$ret;$ret=undefined;");
    }

    function genLogoVarRef(curToken, srcmap) {
        let varName = logo.env.extractVarName(curToken);
        return _varScopes.isLocalVar(varName) ?
            Code.expr("logo.lrt.util.logoVar(", varName, ", \"", varName, "\",", logo.type.srcmapToJs(srcmap),
                ")") :
            Code.expr("logo.lrt.util.logoVar(logo.env.findLogoVarScope(\"", varName, "\", $scopeCache)[\"",
                varName, "\"", "], \"", varName, "\",", logo.type.srcmapToJs(srcmap), ")");
    }

    function genLogoVarLref(varName) {
        return _varScopes.isLocalVar(varName) ? Code.expr(varName) :
            Code.expr("logo.env.findLogoVarScope('" + varName + "', $scopeCache)['" + varName + "']");
    }

    function genLogoSlotRef(curToken, srcmap) {
        let slotNum = logo.env.extractSlotNum(curToken);
        return Code.expr("logo.env.callPrimitive(\"?\",", logo.type.srcmapToJs(srcmap), ",", slotNum, ")");
    }

    function genInstrListCall(curToken, srcmap) {
        return Code.expr()
            .append("(")
            .append(genPrepareCall(defaultInstrListName, srcmap))
            .append("$ret);\n")
            .append("$ret=")
            .append(genCallLogoInstrList())
            .append(genLogoVarRef(curToken, srcmap))
            .append(");")
            .append("(")
            .append(genCompleteCall())
            .append("$ret);\n");
    }

    function insertDelimiters(param, delimiter) {
        let ret = param.map(v => [v, delimiter]).reduce((accumulator, currentValue) =>
            accumulator.concat(currentValue), []);
        ret.pop();
        return ret;
    }

    function containsPostFix(codeArray) {
        return codeArray.map(p => (p instanceof Code) && p.postFix())
            .reduce((acc, cur) => acc || cur, false);
    }

    function genUserProcCall(evxContext, curToken, srcmap) {
        let param = genUserProcCallParams(evxContext, curToken, logo.env._ws[curToken].formal.length);
        let postfix = sys.Config.get("postfix") || containsPostFix(param);
        return !postfix ? genInfixUserProcCall(curToken, srcmap, param) :
            genPostfixUserProcCall(curToken, srcmap, param);
    }

    function genInfixUserProcCall(curToken, srcmap, param) {
        return Code.expr()
            .append("(")
            .append(genPrepareCall(curToken, srcmap))
            .append("$ret=(", genAwait(), "logo.env._user[\"", curToken, "\"](")
            .append(Code.expr.apply(undefined, insertDelimiters(param, ",")))
            .append(")),")
            .append(genCompleteCall())
            .append("$ret)");
    }

    function genPostfixUserProcCall(curToken, srcmap, param) {
        let code = Code.expr();

        code.withPostFix(true);
        code.append("$param.begin([]);\n");

        param.map((p) => {
            code.append(p);
            code.append(";\n$param.add($ret);\n");
        });

        code.append(genPrepareCall(curToken, srcmap));
        code.append("$ret;\n");

        code.append("$ret=", genAwait(), "logo.env._user[", "\"" + curToken + "\"",
            "].apply(undefined,$param.end());\n");

        code.append(genCompleteCall());
        code.append("$ret;\n");

        return code;
    }

    function genUserProcCallParams(evxContext, procName, paramListLength, precedence) {
        let param = [];
        for (let j = 0; j < paramListLength; j++) { // push actual parameters
            evxContext.next();
            param.push(genProcInput(evxContext, precedence, false, procName));
        }

        return param;
    }

    function genPrimitiveCall(evxContext, curToken, srcmap, isInParen) {
        let param = genPrimitiveCallParams(evxContext, curToken, logo.lrt.util.getPrimitivePrecedence(curToken),
            isInParen);

        if (!(curToken in genLambda)) {
            let postfix = sys.Config.get("postfix") || containsPostFix(param);

            return !postfix ? genInfixPrimitiveCall(curToken, srcmap, param).prepend("$ret=") :
                genPostfixPrimitiveCall(curToken, srcmap, param).prepend("$ret=");
        }

        return genPostfixPrimitiveCall(curToken, srcmap, param)
            .prepend("try {\n$ret=")
            .append("} catch (e) {\n")
            .append("if (!logo.type.LogoException.is(e) || !e.isStop()) {throw e;}\n")
            .append("return;}\n");
    }

    function genInfixPrimitiveCall(curToken, srcmap, param) {
        let code = Code.expr();

        code.append("(");
        if  (curToken in genLambda) {
            code.append(genStashLocalVars());
        }

        code.append("($ret=");
        code.append(genCallPrimitive());
        code.append("(\"");

        code.append(curToken, "\", ", logo.type.srcmapToJs(srcmap), ",");
        code.append(Code.expr.apply(undefined, insertDelimiters(param, ",")));
        code.append("))");

        if (curToken in genLambda) {
            code.append(",");
            code.append(genApplyLocalVars());
            code.append("$ret");
        }

        code.append(")");

        return code;
    }

    function genPostfixPrimitiveCall(curToken, srcmap, param) {
        let code = Code.expr();

        code.withPostFix(true);
        if  (curToken in genLambda) {
            code.append(genStashLocalVars());
        }

        code.append("$param.begin([\"", curToken, "\",", logo.type.srcmapToJs(srcmap), "]);\n");

        param.map((p) => {
            code.append(p);
            code.append(";\n$param.add($ret);\n");
        });

        code.append("$ret=");
        code.append(genCallPrimitive());
        code.append(".apply(undefined,$param.end());\n");

        if (curToken in genLambda) {

            code.append(genApplyLocalVars());
            code.append("$ret;");
        }

        return code;
    }

    function genPrimitiveCallParams(evxContext, primitiveName, precedence = 0, isInParen = false) {
        let param = [];
        let paramListLength = logo.lrt.util.getPrimitiveParamCount(primitiveName);
        let paramListMinLength = logo.lrt.util.getPrimitiveParamMinCount(primitiveName);
        let paramListMaxLength = logo.lrt.util.getPrimitiveParamMaxCount(primitiveName);
        let j = 0;

        if (isInParen && (paramListMaxLength > paramListLength || paramListMaxLength == -1)) {
            for (; (j < paramListMaxLength || paramListMaxLength == -1) &&
                    (isInParen && evxContext.peekNextToken() != ")" ) && evxContext.next(); j++) {
                param.push(genToken(evxContext, precedence));
            }
        } else {
            for (; j < paramListLength && ((isInParen && evxContext.peekNextToken() != ")" ) || !isInParen) &&
                    evxContext.next(); j++) { // push actual parameters
                param.push(genProcInput(evxContext, precedence, false, primitiveName));
            }
        }

        if (j < paramListMinLength) {
            param.push(genThrowNotEnoughInputs(evxContext.getSrcmap(), primitiveName));
        }

        return param;
    }

    function genArray(obj) {
        sys.assert(logo.type.isLogoArray(obj));
        return JSON.stringify(obj.map(sys.toNumberIfApplicable));
    }

    function genLogoList(obj, srcmap) {
        sys.assert(logo.type.isLogoList(obj));
        let comp = logo.type.embedSrcmap(obj, srcmap);
        return JSON.stringify(comp.map(sys.toNumberIfApplicable));
    }

    function genToken(evxContext, precedence = 0, isInParen = false) {
        return genTokenHelper(evxContext, isInParen).appendBinaryOperatorExprs(evxContext, precedence);
    }

    function genTokenHelper(evxContext, isInParen) {
        let curToken = evxContext.getToken();
        let srcmap = evxContext.getSrcmap();

        if (sys.isUndefined(curToken) || curToken === "\n") {
            return CODEGEN_CONSTANTS.NOP; // make sure eval() returns undefined
        }

        if (logo.type.isNumericConstant(curToken)) {
            return Code.expr(Number(curToken)).captureRetVal();
        } else if (logo.type.isStopStmt(curToken)) {
            if (!_isLambda) {
                return Code.expr("return");
            }

            let code = Code.expr();
            code.append("throwRuntimeLogoException('STOP',", logo.type.srcmapToJs(srcmap), ",[\"" +
                curToken + "\"])");

            return code;
        } else if (logo.type.isOutputStmt(curToken)) {
            evxContext.next();
            return Code.expr(genToken(evxContext)).append(";return $ret");
        } else if (logo.type.isOpenParen(curToken)) {
            return Code.expr(genParen(evxContext));
        } else if (logo.type.isCompoundObj(curToken)) {
            return genCompoundObj(curToken, srcmap);
        } else if (logo.type.isQuotedLogoWord(curToken)) {
            return Code.expr(logo.type.quotedLogoWordToJsStringLiteral(curToken)).captureRetVal();
        } else if (logo.type.isLogoVarRef(curToken)) {
            return Code.expr(genLogoVarRef(curToken, srcmap)).captureRetVal();
        } else if (logo.type.isLogoSlot(curToken)) {
            return Code.expr(genLogoSlotRef(curToken, srcmap)).captureRetVal();
        } else { // call
            return genCall(evxContext, curToken, srcmap, isInParen);
        }
    }

    function genProcInput(evxContext, precedence, isInParen, procName) {
        let procInput = genToken(evxContext, precedence, isInParen);
        if (procInput == CODEGEN_CONSTANTS.NOP) {
            procInput = genThrowNotEnoughInputs(evxContext.getSrcmap(), procName);
        }

        return procInput;
    }

    function genBody(evxContext, isInstrList) {
        let code = Code.expr();

        do {
            let codeFromToken = genToken(evxContext);
            code.append(codeFromToken);
            code.append(";\n");
            if (codeFromToken.isExpr() && sys.Config.get("unactionableDatum") && (!isInstrList || evxContext.hasNext())) {
                code.append("checkUnactionableDatum($ret,", logo.type.srcmapToJs(evxContext.getSrcmap()), ");\n");
            }

        } while (!evxContext.next().isEol());

        return code;
    }

    function genInstrListLambdaDeclCode(evxContext, param) {
        _isLambda = true;
        _varScopes.enter();
        let code = Code.expr();
        code.append("(", genAsync(), "(");

        if (param !== undefined) {
            code.append(Code.expr.apply(undefined, insertDelimiters(param, ",")));
            param.forEach(v => _varScopes.addVar(v));
        }

        code.append(")=>{");

        code.append("let $scopeCache = {};\n");

        if (param !== undefined) {
            code.append("let $scope = {}; logo.env._scopeStack.push($scope);\n");
        } else {
            code.append("let $scope = logo.env._scopeStack[logo.env._scopeStack.length - 1];\n");
        }

        code.append(genBody(evxContext, true));

        code.append("(");
        code.append(genStashLocalVars());
        code.append("$ret);");

        if (param !== undefined) {
            code.append("logo.env._scopeStack.pop();\n");
        }

        code.append("return $ret;");
        code.append("})");
        _varScopes.exit();

        let mergedCode = code.merge();
        sys.trace(mergedCode, "codegen.lambda");
        return mergedCode;
    }
    codegen.genInstrListLambdaDeclCode = genInstrListLambdaDeclCode;

    function genParen(evxContext) {
        let code = Code.expr();

        let codeFromToken = genToken(evxContext.next(), 0, true);
        code.append(codeFromToken);

        if (evxContext.next().getToken() != ")") {
            code.append(
                "(throwRuntimeLogoException(",
                "\"TOO_MUCH_INSIDE_PAREN\",",
                logo.type.srcmapToJs(evxContext.getSrcmap()),
                "))");
        }

        return code;
    }

    function genTopLevelCode(p) {

        let oldFuncName = _funcName;
        _funcName = "";
        _isLambda = false;

        let evxContext = logo.interpreter.makeEvalContext(p);

        _varScopes.enter();
        let code = genBody(evxContext).merge();
        _varScopes.exit();

        let ret = "$scopeCache={};" +
                "logo.env._user.$ = async function(){\n" +
                "let $scope={},$scopeCache={};\n" +
                "logo.env._scopeStack.push($scope);\n" +
                code + "logo.env._scopeStack.pop();}";

        _funcName = oldFuncName;
        return ret;
    }
    codegen.genTopLevelCode = genTopLevelCode;

    function genPrepareCall(target, srcmap) {
        let code = Code.expr();

        if (sys.Config.get("dynamicScope")) {
            code.append(genStashLocalVars());
        }

        code.append("logo.env._callstack.push([logo.env._curProc," + logo.type.srcmapToJs(srcmap) + "]),");
        code.append("logo.env._curProc=\"" + target + "\",\n");

        return code;
    }

    function genCompleteCall() {
        let code = Code.expr();
        code.append("logo.env._curProc=logo.env._callstack.pop()[0],");
        if (sys.Config.get("dynamicScope")) {
            code.append(genApplyLocalVars());
        }

        return code;
    }

    function genStashLocalVars() {
        let code = Code.expr();
        _varScopes.localVars().forEach((varName) =>
            code.append("($scope['", varName, "']=", varName, "),"));

        return code;
    }

    function genApplyLocalVars() {
        let code = Code.expr();
        _varScopes.localVars().forEach(varName =>
            code.append("(", varName, "=$scope['", varName, "']),"));

        return code;
    }

    function genProc(p, srcmap) {
        let code = Code.expr();
        code.append(genAsync(), "function ");

        if(!logo.type.isLogoProc(p)) {
            return;
        }

        let oldFuncName = _funcName;
        _funcName = p[1];

        let evxContext = logo.interpreter.makeEvalContext(logo.type.embedSrcmap(p[3], srcmap[3]));
        code.append(_funcName, "(");

        let params = p[2];
        code.append(Code.expr.apply(undefined, insertDelimiters(params, ",")));
        code.append(")");
        code.append("{\n");
        code.append("let $ret, $param = logo.env.createParamScope();\n");

        if (sys.Config.get("dynamicScope")) {
            code.append("let $scope = {}, $scopeCache = {};\n");
            code.append("logo.env._scopeStack.push($scope);\n");
        }

        _varScopes.enter();
        params.forEach(v => _varScopes.addVar(v));
        code.append(genBody(evxContext));
        _varScopes.exit();

        code.append("logo.env._scopeStack.pop();\n");
        code.append("}\n");

        code.prepend("logo.env._user[\"" + _funcName + "\"]=");
        code.append("undefined;\n");

        _funcName = oldFuncName;
        return code;
    }

    function genThrowNotEnoughInputs(srcmap, procName) {
        return Code.expr("throwRuntimeLogoException('NOT_ENOUGH_INPUTS',",
            logo.type.srcmapToJs(srcmap), ",[ \"" + procName + "\"])");
    }

    function genThrowUnknownProc(srcmap, procName) {
        return Code.expr("throwRuntimeLogoException('UNKNOWN_PROC',",
            logo.type.srcmapToJs(srcmap), ",[ \"" + procName + "\"])");
    }

    function genCompoundObj(curToken, srcmap) {
        let code = Code.expr();
        if (!logo.type.isLogoProc(curToken)) {
            code.append("$ret=");
        }

        code.append(logo.type.isLogoProc(curToken) ? genProc(curToken, srcmap) :
            logo.type.isLogoArray(curToken) ?  genArray(curToken, srcmap) :
                genLogoList(curToken, srcmap));

        return code;
    }

    function genCall(evxContext, curToken, srcmap, isInParen) {
        let code = Code.expr();

        if (curToken in genNativeJs) {
            let nativeJsCode = genNativeJs[curToken](evxContext, isInParen);
            if (nativeJsCode.isExpr()) {
                code.append("$ret=");
            }

            code.append(nativeJsCode);
        } else if (curToken in logo.lrt.primitive) {
            code.append(genPrimitiveCall(evxContext, curToken, srcmap, isInParen));
        } else if (curToken in logo.env._ws) {
            code.append("$ret=");
            code.append(genUserProcCall(evxContext, curToken, srcmap));
        } else {
            code.append(genThrowUnknownProc(srcmap, curToken));
        }

        return code;
    }

    function genAsync() {
        return logo.env.getAsyncFunctionCall() ? "async " : "";
    }

    function genAwait() {
        return logo.env.getAsyncFunctionCall() ? "await " : "";
    }

    function genCallPrimitive() {
        return logo.env.getAsyncFunctionCall() ? "await logo.env.callPrimitiveAsync" :
            "logo.env.callPrimitive";
    }

    function genCallPrimitiveOperator() {
        return logo.env.getAsyncFunctionCall() ? "await logo.env.callPrimitiveOperatorAsync" :
            "logo.env.callPrimitiveOperator";
    }

    function genCallLogoInstrList() {
        return logo.env.getAsyncFunctionCall() ? "await callLogoInstrListAsync(" : "callLogoInstrList(";
    }

    return codegen;
};

if (typeof exports != "undefined") {
    exports.$classObj = $classObj;
}
