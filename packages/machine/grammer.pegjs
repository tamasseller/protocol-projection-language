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
  = _ s:(Block
  / IfStatement
  / DoWhileStatement
  / WhileStatement
  / ForStatement
  / SwitchStatement
  / DeclarationStatement
  / BreakStatement
  / ReturnStatement
  / ExpressionStatement) { return s; }

// The single construct directly governed by if/else/while/for: either a
// brace-delimited block or one bare statement. In this position the `Block`
// *is* the branch's or loop's own RTL block, so its locals go out with that
// block's `BLOCK_END`; standalone (as an ordinary `Statement`) nothing closes
// it and the lowering ends the scope with a `DROP` instead — see
// docs/isa-core.md §4.4 and §10.2.
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

DoWhileStatement
  = "do" _ body:ControlBody _ "while" _ "(" _ test:Expression _ ")" _ ";" {
      return { type: "DoWhileStatement", test, body };
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

// One type name, then any number of comma-separated declarators sharing it.
// Each is its own push, in order, exactly as if written on separate lines.
DeclarationStatement
  = varType:TypeName _ head:Declarator tail:(_ "," _ d:Declarator { return d; })* _ ";" {
      return {
        type: "VariableDeclaration",
        declarations: [head, ...tail].map(d => ({ type: "VariableDeclarator", varType, id: d.id, init: d.init }))
      };
    }

Declarator
  = id:Identifier _ init:("=" _ expr:Expression { return expr; })? {
      return { id, init: init !== null ? init : null };
    }

// The six primitive types. Order matters only in that no name is a prefix
// of another, so a plain ordered choice is unambiguous.
TypeName "type name"
  = name:("u32" / "u16" / "u8" / "i32" / "i16" / "i8") !([a-zA-Z0-9_]) {
      return name;
    }

BreakStatement
  = "break" _ ";" {
      return { type: "BreakStatement" };
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
  / CastExpression
  / CallExpression
  / Identifier
  / "(" _ expr:Expression _ ")" { return expr; }

// Function-call syntax rather than C's `(i16)x`: a leading parenthesis is
// already a parenthesized expression here, and telling the two apart needs
// unbounded lookahead. `i16(x)` needs none, and reads better.
CastExpression
  = varType:TypeName _ "(" _ argument:Expression _ ")" {
      return { type: "CastExpression", varType, argument };
    }

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
  / BinaryLiteral
  / OctalLiteral
  / DecimalLiteral

HexLiteral
  = "0x"i digits:$[0-9a-fA-F]+ { 
      return { type: "Literal", value: parseInt(digits, 16), raw: text() }; 
    }

BinaryLiteral
  = "0b"i digits:$[01]+ {
      return { type: "Literal", value: parseInt(digits, 2), raw: text() };
    }

// C reads a leading zero as octal; this DSL has no octal literals, so it
// rejects the spelling rather than silently disagreeing with C about what
// `010` means. Plain `0` is a DecimalLiteral — this needs a digit after it.
OctalLiteral
  = "0" digits:$[0-9]+ {
      error(`leading zeros are not allowed ('0${digits}' is octal in C, and this DSL has no octal literals)`);
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
    / "do" / "break" / "continue" / "return"
    / "u32" / "u16" / "u8" / "i32" / "i16" / "i8"
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