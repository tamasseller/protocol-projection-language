// =====================================================================
// Minimal C-like DSL Grammar for Peggy
// =====================================================================

{
  // Helper to build left-associative binary expression trees
  function buildBinary(head, tail) {
    return tail.reduce((result, element) => ({
      type: element.logical ? "LogicalExpression" : "BinaryExpression",
      operator: element.op,
      left: result,
      right: element.right
    }), head);
  }
}

// ---------------------------------------------------------------------
// 1. Entry Point
// ---------------------------------------------------------------------
Program
  = _ body:Statement* _ { 
      return { type: "Program", body }; 
    }

// ---------------------------------------------------------------------
// 2. Statements
// ---------------------------------------------------------------------
Statement
  = _ s:(IfStatement
  / WhileStatement
  / ForStatement
  / SwitchStatement
  / DeclarationStatement
  / ReturnStatement
  / ExpressionStatement) { return s; }

// The single construct directly governed by if/else/while/for: either a
// brace-delimited block or one bare statement. A `Block` is reachable only
// here — it is deliberately not a `Statement` in its own right, so a bare
// `{ ... }` cannot appear as a standalone statement (e.g. nested inside
// another block, or at the top level of a procedure body). Every `Block`
// reached via `ControlBody` is the immediate body of a branch or loop, so it
// always has a real RTL block construct (a `BR_TABLE` case or a `LOOP` body
// block) backing it — see docs/isa-core.md §20.2 and §15.1. A `Block` with
// no such construct behind it would have no `BLOCK_END` to reclaim its
// locals' TOS depth at, silently corrupting register allocation for any
// declaration that follows it.
ControlBody
  = Block
  / Statement

Block
  = "{" _ body:Statement* _ "}" {
      return { type: "BlockStatement", body };
    }

IfStatement
  = "if" _ "(" _ test:Expression _ ")" _ consequent:ControlBody
    alternate:(_ "else" _ alt:ControlBody { return alt; })? {
      return { type: "IfStatement", test, consequent, alternate };
    }

WhileStatement
  = "while" _ "(" _ test:Expression _ ")" _ body:ControlBody {
      return { type: "WhileStatement", test, body };
    }

ForStatement
  = "for" _ "(" _
    init:(DeclarationStatement / ExpressionStatement / ";" { return null; }) _
    test:Expression? _ ";" _
    update:Expression? _ ")" _ body:ControlBody {
      // Clean up the init statement to unpack if it's an ExpressionStatement
      const initNode = init?.type === "ExpressionStatement" ? init.expression : init;
      return { type: "ForStatement", init: initNode, test, update, body };
    }

SwitchStatement
  = "switch" _ "(" _ discriminant:Expression _ ")" _ "{" _ 
    cases:SwitchCase* _ 
    "}" { 
      return { type: "SwitchStatement", discriminant, cases }; 
    }

SwitchCase
  = _ "case" _ test:Expression _ ":" _ consequent:Statement* {
      return { type: "SwitchCase", test, consequent };
    }
  / _ "default" _ ":" _ consequent:Statement* {
      return { type: "SwitchCase", test: null, consequent };
    }

DeclarationStatement
  = "u32" _ id:Identifier _ init:("=" _ expr:Expression { return expr; })? _ ";" { 
      return { 
        type: "VariableDeclaration", 
        declarations: [{ type: "VariableDeclarator", id, init: init !== null ? init : null }]
      }; 
    }

ReturnStatement
  = "return" _ argument:Expression? _ ";" { 
      return { type: "ReturnStatement", argument }; 
    }



ExpressionStatement
  = expression:Expression _ ";" { 
      return { type: "ExpressionStatement", expression }; 
    }


// ---------------------------------------------------------------------
// 3. Expressions (Precedence Climbing)
// ---------------------------------------------------------------------
Expression = AssignmentExpression

AssignmentExpression
  = left:LeftHandSideExpression _ 
    operator:("=" / "+=" / "-=" / "*=" / "/=" / "%=" / "<<=" / ">>=" / "&=" / "^=" / "|=") _ 
    right:AssignmentExpression { 
      return { type: "AssignmentExpression", operator, left, right }; 
    }
  / ConditionalExpression

ConditionalExpression
  = test:LogicalORExpression _ "?" _ consequent:Expression _ ":" _ alternate:AssignmentExpression {
      return { type: "ConditionalExpression", test, consequent, alternate };
    }
  / LogicalORExpression

LogicalORExpression
  = head:LogicalANDExpression tail:(_ op:"||" _ right:LogicalANDExpression { return { logical: true, op, right }; })* {
      return buildBinary(head, tail);
    }

LogicalANDExpression
  = head:BitwiseORExpression tail:(_ op:"&&" _ right:BitwiseORExpression { return { logical: true, op, right }; })* {
      return buildBinary(head, tail);
    }

BitwiseORExpression
  = head:BitwiseXORExpression tail:(_ op:"|" _ right:BitwiseXORExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

BitwiseXORExpression
  = head:BitwiseANDExpression tail:(_ op:"^" _ right:BitwiseANDExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

BitwiseANDExpression
  = head:EqualityExpression tail:(_ op:"&" _ right:EqualityExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

EqualityExpression
  = head:RelationalExpression tail:(_ op:("==" / "!=") _ right:RelationalExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

RelationalExpression
  = head:ShiftExpression tail:(_ op:("<=" / ">=" / "<" / ">") _ right:ShiftExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

ShiftExpression
  = head:AdditiveExpression tail:(_ op:("<<" / ">>") _ right:AdditiveExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

AdditiveExpression
  = head:MultiplicativeExpression tail:(_ op:("+" / "-") _ right:MultiplicativeExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

MultiplicativeExpression
  = head:PrefixExpression tail:(_ op:("*" / "/" / "%") _ right:PrefixExpression { return { op, right }; })* {
      return buildBinary(head, tail);
    }

PrefixExpression
  = operator:("++" / "--" / "+" / "-" / "~" / "!") _ argument:PrefixExpression {
      const type = (operator === "++" || operator === "--") ? "UpdateExpression" : "UnaryExpression";
      return { type, operator, argument, prefix: true };
    }
  / PostfixExpression

PostfixExpression
  = argument:PrimaryExpression _ operator:("++" / "--") {
      return { type: "UpdateExpression", operator, argument, prefix: false };
    }
  / PrimaryExpression

// Excludes things that can't be assigned to (like function calls or numbers)
LeftHandSideExpression
  = Identifier

PrimaryExpression
  = Literal
  / CallExpression
  / Identifier
  / "(" _ expr:Expression _ ")" { return expr; }

CallExpression
  = callee:Identifier _ "(" _ args:ArgumentList? _ ")" { 
      return { type: "CallExpression", callee, arguments: args !== null ? args : [] }; 
    }

ArgumentList
  = head:Expression tail:(_ "," _ expr:Expression { return expr; })* {
      return [head, ...tail];
    }


// ---------------------------------------------------------------------
// 4. Lexical Tokens
// ---------------------------------------------------------------------
Literal
  = HexLiteral
  / DecimalLiteral

HexLiteral
  = "0x"i digits:$[0-9a-fA-F]+ { 
      return { type: "Literal", value: parseInt(digits, 16), raw: text() }; 
    }

DecimalLiteral
  = digits:$[0-9]+ { 
      return { type: "Literal", value: parseInt(digits, 10), raw: text() }; 
    }

Identifier
  = !ReservedWord name:$([a-zA-Z_][a-zA-Z0-9_]*) { 
      return { type: "Identifier", name }; 
    }

ReservedWord
  = ( "if" / "else" / "while" / "for" / "switch" / "case" / "default"
    / "break" / "continue" / "return" / "u32"
    ) !([a-zA-Z0-9_])

// ---------------------------------------------------------------------
// 5. Whitespace and Comments
// ---------------------------------------------------------------------
_ "whitespace"
  = (WhiteSpace / MultiLineComment / SingleLineComment)*

WhiteSpace
  = [ \t\n\r]+

MultiLineComment
  = "/*" (!"*/" .)* "*/"

SingleLineComment
  = "//" (![\n\r] .)*