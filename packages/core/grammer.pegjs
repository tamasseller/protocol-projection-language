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
  / WhileStatement
  / DoWhileStatement
  / ForStatement
  / SwitchStatement
  / DeclarationStatement
  / ReturnStatement
  / BreakStatement
  / ContinueStatement
  / ExpressionStatement) { return s; }

Block
  = "{" _ body:Statement* _ "}" { 
      return { type: "BlockStatement", body }; 
    }

IfStatement
  = "if" _ "(" _ test:Expression _ ")" _ consequent:Statement 
    alternate:(_ "else" _ alt:Statement { return alt; })? { 
      return { type: "IfStatement", test, consequent, alternate }; 
    }

WhileStatement
  = "while" _ "(" _ test:Expression _ ")" _ body:Statement { 
      return { type: "WhileStatement", test, body }; 
    }

DoWhileStatement
  = "do" _ body:Statement _ "while" _ "(" _ test:Expression _ ")" _ ";" { 
      return { type: "DoWhileStatement", body, test }; 
    }

ForStatement
  = "for" _ "(" _ 
    init:(DeclarationStatement / ExpressionStatement / ";" { return null; }) _ 
    test:Expression? _ ";" _ 
    update:Expression? _ ")" _ body:Statement { 
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

BreakStatement
  = "break" _ ";" { return { type: "BreakStatement" }; }

ContinueStatement
  = "continue" _ ";" { return { type: "ContinueStatement" }; }

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
  = ( "if" / "else" / "while" / "do" / "for" / "switch" / "case" / "default" 
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