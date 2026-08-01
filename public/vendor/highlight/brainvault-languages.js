/* BrainVault supplemental Highlight.js grammars for languages not included in the common bundle. */
(function registerBrainVaultLanguages(root) {
  "use strict";

  const hljs = root && root.hljs;
  if (!hljs || typeof hljs.registerLanguage !== "function") return;

  const register = (name, definition) => {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, definition);
  };

  const quotedStrings = (language) => [
    language.QUOTE_STRING_MODE,
    language.APOS_STRING_MODE
  ];

  register("dart", (language) => ({
    name: "Dart",
    aliases: ["dartlang"],
    keywords: {
      keyword: "abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin native new null of on operator part required rethrow return sealed set show static super switch sync this throw true try typedef var void when while with yield",
      built_in: "BigInt bool DateTime double Duration Enum Future Function int Iterable Iterator List Map Never num Object Pattern Record RegExp Runes Set StackTrace Stopwatch Stream String StringBuffer Symbol Type Uri"
    },
    contains: [
      language.C_LINE_COMMENT_MODE,
      language.C_BLOCK_COMMENT_MODE,
      { scope: "meta", begin: /@[A-Za-z_]\w*/ },
      ...quotedStrings(language),
      language.C_NUMBER_MODE
    ]
  }));

  register("powershell", (language) => ({
    name: "PowerShell",
    aliases: ["pwsh", "ps1"],
    case_insensitive: true,
    keywords: {
      keyword: "begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return static switch throw trap try until using var while workflow",
      literal: "$true $false $null",
      built_in: "Add-Content Clear-Content Clear-Item Copy-Item Export-Csv ForEach-Object Format-List Format-Table Get-ChildItem Get-Command Get-Content Get-Help Get-Item Get-Member Import-Csv Invoke-Command Invoke-Expression Join-Path Measure-Object Move-Item New-Item Out-File Read-Host Remove-Item Rename-Item Select-Object Set-Content Set-Item Sort-Object Split-Path Start-Process Stop-Process Test-Path Where-Object Write-Debug Write-Error Write-Host Write-Output Write-Verbose Write-Warning"
    },
    contains: [
      language.HASH_COMMENT_MODE,
      { scope: "variable", begin: /\$\{?[A-Za-z_][\w:]*\}?/ },
      { scope: "string", begin: /@"/, end: /^"@/ },
      { scope: "string", begin: /@'/, end: /^'@/ },
      ...quotedStrings(language),
      language.C_NUMBER_MODE
    ]
  }));

  register("basic", (language) => ({
    name: "BASIC",
    aliases: ["vb", "qbasic"],
    case_insensitive: true,
    keywords: {
      keyword: "AND AS ASC ATN BYREF BYVAL CALL CASE CBOOL CBYTE CCUR CDATE CDBL CDEC CINT CLNG CONST CONTINUE CSNG CSTR DATE DECLARE DIM DO EACH ELSE ELSEIF END ENUM ERASE ERROR EVENT EXIT FALSE FOR FUNCTION GET GOSUB GOTO IF IMPLEMENTS IN INPUT INTERFACE IS LET LOOP MOD MODULE NEW NEXT NOT NOTHING ON OPEN OPTION OR PRINT PRIVATE PROPERTY PUBLIC PUT RANDOMIZE READ REDIM REM RESET RESUME RETURN SELECT SET SHARED STATIC STEP STOP SUB THEN TO TRUE TYPE UNTIL WEND WHILE WITH WRITE XOR",
      built_in: "ABS ARRAY CHR COS EXP FIX HEX INSTR INT LCASE LEFT LEN LOG LTRIM MID OCT REPLACE RIGHT RND ROUND RTRIM SIN SPACE SQR STRING TAN TIMER TRIM UCASE VAL"
    },
    contains: [
      { scope: "comment", begin: /(^|\s)'/, end: /$/ },
      { scope: "comment", begin: /\bREM\b/, end: /$/ },
      language.QUOTE_STRING_MODE,
      language.C_NUMBER_MODE
    ]
  }));

  register("x86asm", (language) => ({
    name: "Assembly",
    aliases: ["asm", "assembly", "x86"],
    case_insensitive: true,
    keywords: {
      keyword: "aaa aad aam aas adc add and call cbw cdq clc cld cli cmc cmp cmpsb cmpsd cmpsw cwd cwde daa das dec div enter hlt idiv imul in inc int into iret ja jae jb jbe jc jcxz je jg jge jl jle jmp jna jnae jnb jnbe jnc jne jng jnge jnl jnle jno jnp jns jnz jo jp jpe jpo js jz lahf lea leave lodsb lodsd lodsw loop loope loopne loopnz loopz mov movsb movsd movsw mul neg nop not or out pop popa popad popf push pusha pushad pushf rcl rcr ret rol ror sahf sal sar sbb scasb scasd scasw shl shr stc std sti stosb stosd stosw sub test wait xchg xlat xor",
      built_in: "eax ebx ecx edx esi edi esp ebp ax bx cx dx si di sp bp al ah bl bh cl ch dl dh cs ds es fs gs ss rax rbx rcx rdx rsi rdi rsp rbp r8 r9 r10 r11 r12 r13 r14 r15 xmm0 xmm1 xmm2 xmm3 xmm4 xmm5 xmm6 xmm7"
    },
    contains: [
      { scope: "comment", begin: /;/, end: /$/ },
      { scope: "symbol", begin: /^[A-Za-z_.$?][\w.$?]*:/ },
      { scope: "meta", begin: /^\s*(?:section|segment|global|extern|bits|org|align|db|dw|dd|dq|equ)\b/ },
      language.C_NUMBER_MODE,
      ...quotedStrings(language)
    ]
  }));

  register("delphi", (language) => ({
    name: "Delphi",
    aliases: ["pascal", "objectpascal"],
    case_insensitive: true,
    keywords: {
      keyword: "absolute abstract and array as asm assembler automated begin case cdecl class const constructor contains default deprecated destructor dispid dispinterface div do downto dynamic else end except experimental export exports external far file finalization finally for forward function goto helper if implementation implements in index inherited initialization inline interface is label library message mod name near nil nodefault not object of on operator or out overload override package packed pascal platform private procedure program property protected public published raise read readonly record register reintroduce repeat requires resident resourcestring safecall sealed set shl shr static stdcall stored strict string then threadvar to try type unit unsafe until uses var varargs virtual while winapi with write writeonly xor",
      literal: "true false nil self result"
    },
    contains: [
      language.C_LINE_COMMENT_MODE,
      language.COMMENT(/\{/, /\}/),
      language.COMMENT(/\(\*/, /\*\)/),
      language.APOS_STRING_MODE,
      language.C_NUMBER_MODE
    ]
  }));

  register("lisp", (language) => ({
    name: "Lisp",
    aliases: ["cl", "commonlisp", "elisp"],
    case_insensitive: true,
    keywords: {
      keyword: "and block catch cond defclass defconstant defgeneric define-condition defmacro defmethod defpackage defparameter defsetf defstruct deftype defun defvar do do* dolist dotimes ecase eval-when flet function go handler-bind handler-case if labels lambda let let* locally loop macrolet multiple-value-bind or otherwise progn progv quote restart-bind restart-case return-from setf symbol-macrolet tagbody the throw typecase unless unwind-protect when",
      built_in: "car cdr cons list append mapcar reduce apply funcall format print princ read eql equal eq atom consp listp numberp stringp symbolp null not values"
    },
    contains: [
      { scope: "comment", begin: /;/, end: /$/ },
      { scope: "literal", begin: /\b(?:nil|t)\b/i },
      { scope: "symbol", begin: /:[A-Za-z_+*<>=!?$%&~^.-][\w+*<>=!?$%&~^.-]*/ },
      language.QUOTE_STRING_MODE,
      language.C_NUMBER_MODE
    ]
  }));

  register("coffeescript", (language) => ({
    name: "CoffeeScript",
    aliases: ["coffee", "cson", "iced"],
    keywords: {
      keyword: "and break by catch class continue delete do else extends false finally for if in instanceof is isnt loop new no not null of off on or own return super switch then this throw true try typeof unless until when while yes yield await async",
      built_in: "Array Boolean Date Error Function JSON Math Number Object RegExp String console exports global module process require"
    },
    contains: [
      language.HASH_COMMENT_MODE,
      { scope: "comment", begin: /###/, end: /###/ },
      { scope: "variable", begin: /@[A-Za-z_]\w*/ },
      { scope: "string", begin: /'''/, end: /'''/ },
      { scope: "string", begin: /\"\"\"/, end: /\"\"\"/ },
      ...quotedStrings(language),
      language.C_NUMBER_MODE
    ]
  }));

  register("cobol", (language) => ({
    name: "COBOL",
    aliases: ["cob"],
    case_insensitive: true,
    keywords: {
      keyword: "ACCEPT ACCESS ADD ADDRESS ADVANCING AFTER ALL ALPHABET ALPHABETIC ALPHANUMERIC ALSO ALTER ALTERNATE AND ANY APPLY ARE AREA AREAS ASCENDING ASSIGN AT AUTHOR BEFORE BINARY BLANK BLOCK BOTTOM BY CALL CANCEL CD CF CH CHARACTER CHARACTERS CLASS CLOCK-UNITS CLOSE COBOL CODE CODE-SET COLLATING COLUMN COMMA COMMON COMMUNICATION COMP COMPUTATIONAL COMPUTE CONFIGURATION CONTAINS CONTENT CONTINUE CONTROL CONTROLS CONVERTING COPY CORR CORRESPONDING COUNT CURRENCY DATA DATE-COMPILED DATE-WRITTEN DAY-OF-WEEK DE DEBUG-CONTENTS DEBUG-ITEM DEBUG-LINE DEBUG-NAME DEBUG-SUB-1 DEBUG-SUB-2 DEBUG-SUB-3 DEBUGGING DECIMAL-POINT DECLARATIVES DELETE DELIMITED DELIMITER DEPENDING DESCENDING DESTINATION DETAIL DISPLAY DIVIDE DIVISION DOWN DUPLICATES DYNAMIC EGI ELSE EMI ENABLE END-ADD END-CALL END-COMPUTE END-DELETE END-DISPLAY END-DIVIDE END-EVALUATE END-IF END-MULTIPLY END-OF-PAGE END-PERFORM END-READ END-RECEIVE END-RETURN END-REWRITE END-SEARCH END-START END-STRING END-SUBTRACT END-UNSTRING END-WRITE ENVIRONMENT EOP EQUAL ERROR ESI EVALUATE EVERY EXCEPTION EXIT EXTEND EXTERNAL FALSE FD FILE FILE-CONTROL FILLER FINAL FIRST FOOTING FOR FROM GENERATE GIVING GLOBAL GREATER GROUP HEADING HIGH-VALUE HIGH-VALUES I-O I-O-CONTROL IDENTIFICATION IF IN INDEX INDEXED INDICATE INITIAL INITIALIZE INITIATE INPUT INPUT-OUTPUT INSPECT INSTALLATION INTO INVALID IS JUSTIFIED KEY LABEL LAST LEADING LEFT LENGTH LESS LIMIT LIMITS LINAGE LINAGE-COUNTER LINE LINE-COUNTER LINES LINKAGE LOCK LOW-VALUE LOW-VALUES MEMORY MERGE MESSAGE MODE MODULES MOVE MULTIPLE MULTIPLY NATIVE NEGATIVE NEXT NO NOT NUMBER NUMERIC OBJECT-COMPUTER OCCURS OF OFF OMITTED ON OPEN OPTIONAL OR ORDER ORGANIZATION OTHER OUTPUT OVERFLOW PACKED-DECIMAL PADDING PAGE PAGE-COUNTER PERFORM PF PH PIC PICTURE PLUS POINTER POSITION POSITIVE PRINTING PROCEDURE PROCEDURES PROCEED PROGRAM-ID PROGRAM PURGE QUEUE QUOTE QUOTES RANDOM READ RECEIVE RECORD RECORDING RECORDS REDEFINES REEL REFERENCES RELATIVE RELEASE REMAINDER REMOVAL REPLACING REPORT REPORTING REPORTS RERUN RESERVE RESET RETURN RETURNING REVERSED REWIND REWRITE RF RH RIGHT ROUNDED RUN SAME SD SEARCH SECURITY SEGMENT SEGMENT-LIMIT SELECT SEND SENTENCE SEPARATE SEQUENCE SEQUENTIAL SET SIGN SIZE SORT SORT-MERGE SOURCE-COMPUTER SPACE SPACES SPECIAL-NAMES STANDARD STANDARD-1 STANDARD-2 START STATUS STOP STRING SUB-QUEUE-1 SUB-QUEUE-2 SUB-QUEUE-3 SUBTRACT SUM SUPPRESS SYMBOLIC SYNC SYNCHRONIZED TABLE TALLYING TAPE TERMINAL TERMINATE TEST TEXT THAN THEN THROUGH THRU TIME TIMES TO TOP TRAILING TRUE TYPE UNIT UNSTRING UNTIL UP UPON USAGE USE USING VALUE VALUES VARYING WHEN WITH WORDS WORKING-STORAGE WRITE ZERO ZEROES ZEROS"
    },
    contains: [
      { scope: "comment", begin: /^\s{0,6}\*/m, end: /$/ },
      { scope: "comment", begin: /\*>/, end: /$/ },
      ...quotedStrings(language),
      language.C_NUMBER_MODE
    ]
  }));

  register("fortran", (language) => ({
    name: "Fortran",
    aliases: ["f90", "f95", "potran"],
    case_insensitive: true,
    keywords: {
      keyword: "allocatable allocate assignment associate asynchronous backspace bind block blockdata call case character class close common contains continue cycle data deallocate default dimension do doubleprecision elemental else elseif elsewhere end endassociate endblock endblockdata enddo endenum endfile endforall endfunction endif endinterface endmodule endprocedure endprogram endselect endsubmodule endsubroutine endtype endwhere entry enum enumerator equivalence error stop exit extends external final flush forall format formatted function generic go goto if implicit import in inquire integer intent interface intrinsic logical module namelist non_intrinsic none nullify only open operator optional parameter pass pause pointer precision print private procedure program protected public pure read real recursive result return rewind save select sequence stop submodule subroutine target then type unformatted use value volatile wait where while write",
      literal: ".true. .false."
    },
    contains: [
      { scope: "comment", begin: /!/, end: /$/ },
      { scope: "meta", begin: /^\s*#/, end: /$/ },
      ...quotedStrings(language),
      language.C_NUMBER_MODE
    ]
  }));

  register("matlab", (language) => ({
    name: "MATLAB",
    aliases: ["octave"],
    keywords: {
      keyword: "arguments break case catch classdef continue else elseif end enumeration events for function global if methods otherwise parfor persistent properties return spmd switch try while",
      built_in: "abs acos asin atan ceil cell char class cos disp double error exp eye false figure floor fprintf full isempty length linspace load log max mean min nan numel ones plot rand reshape save size sparse sqrt std strcmp struct sum true zeros"
    },
    contains: [
      { scope: "comment", begin: /%\{/, end: /%\}/ },
      { scope: "comment", begin: /%/, end: /$/ },
      language.APOS_STRING_MODE,
      language.QUOTE_STRING_MODE,
      language.C_NUMBER_MODE
    ]
  }));

  register("haskell", (language) => ({
    name: "Haskell",
    aliases: ["hs"],
    keywords: {
      keyword: "as case class data default deriving do else family forall foreign hiding if import in infix infixl infixr instance let mdo module newtype of pattern proc qualified rec role safe then type unsafe where",
      built_in: "Bool Char Double Either Eq False FilePath Float Foldable Fractional Functor IO Int Integer Integral Just Left Maybe Monad Nothing Num Ord Ordering Rational Read Real Right Semigroup Show String Traversable True Word"
    },
    contains: [
      { scope: "comment", begin: /--/, end: /$/ },
      language.COMMENT(/\{-/, /-\}/, { contains: ["self"] }),
      { scope: "meta", begin: /\{-#/, end: /#-\}/ },
      language.QUOTE_STRING_MODE,
      language.APOS_STRING_MODE,
      language.C_NUMBER_MODE
    ]
  }));
})(typeof globalThis !== "undefined" ? globalThis : this);
