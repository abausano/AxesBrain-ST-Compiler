(* Confronto C++ / .stc: STRING, letterali, assegnamento, confronti e funzioni standard. *)

FUNCTION Saluta : STRING
  VAR_INPUT Nome : STRING; END_VAR
  Saluta := CONCAT('Ciao ', Nome);
END_FUNCTION

FUNCTION Accoda : INT
  VAR_IN_OUT S : STRING; END_VAR
  VAR_INPUT X : STRING(10); END_VAR
  S := CONCAT(S, X);
  Accoda := LEN(S);
END_FUNCTION

PROGRAM Str
  VAR
    c : INT;
    a : STRING := 'abc';
    b : STRING(5) := 'xyz';
    corto : STRING(4);
    vuota : STRING;
    s1 : STRING; s2 : STRING; s3 : STRING; s4 : STRING; s5 : STRING; s6 : STRING; s7 : STRING;
    s8 : STRING; s9 : STRING; s10 : STRING;
    n1 : INT; n2 : INT; n3 : INT; n4 : INT;
    e1 : BOOL; e2 : BOOL; e3 : BOOL; e4 : BOOL; e5 : BOOL;
    acc : STRING;                      (* il C++ lega un VAR_IN_OUT STRING solo a STRING(254) *)
    lacc : INT;
    esc : STRING := 'a$$b$'c$Nd';
    num : STRING; num2 : STRING;
  END_VAR

  c := c + 1;
  s1 := CONCAT(a, b);
  s2 := CONCAT(CONCAT(a, '-'), CONCAT(CONCAT(b, '-'), a));  (* il C++ non compila CONCAT a 5 argomenti misti *)
  corto := s1;                       (* troncata a 4 *)
  s3 := LEFT(s1, 2);
  s4 := RIGHT(s1, 4);
  s5 := MID(s1, 3, 2);
  s6 := INSERT(a, 'XY', 2);
  s7 := DELETE(s1, 2, 3);
  s8 := REPLACE(s1, '--', 1, 4);
  n1 := LEN(s2);
  n2 := FIND(s2, '-');
  n3 := FIND(s2, 'zz');
  n4 := LEN(vuota);
  e1 := a = 'abc';
  e2 := a < b;
  e3 := s1 <> s2;
  e4 := a <> s3;                     (* il C++ non compila >= tra STRING *)
  e5 := corto = 'abcx';
  s9 := Saluta(a);
  s10 := Saluta(Nome := CONCAT(b, b));
  IF c <= 5 THEN
    lacc := Accoda(acc, 'ab');
  END_IF
  num := DINT_TO_STRING(c * 1000 - 3);
  num2 := REAL_TO_STRING(INT_TO_REAL(c) / 4.0);
  a := CONCAT(a, 'd');
  IF LEN(a) > 8 THEN a := 'abc'; END_IF
END_PROGRAM
