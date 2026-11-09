(* Confronto C++ / .stc: funzioni OSCAT BASIC su array e stringhe tramite puntatori. *)

PROGRAM Osc2
  VAR
    c : INT;
    f1 : DINT; g1 : INT; h1 : REAL; ce : INT; fr : REAL; fl : INT;
    arr : ARRAY[1..8] OF REAL := [5.0, 3.0, 9.0, 1.0, 7.0, 2.0, 8.0, 4.0];
    ok : BOOL; avg : REAL; mx : REAL;
    s1 : STRING; s2 : STRING; s3 : STRING; s4 : STRING; s5 : STRING;
    s6 : STRING; s7 : STRING; s8 : STRING; s9 : STRING;
    di : INT; nc : INT; fc : INT;
    dw : INT; ly : BOOL; dm : INT; d1 : DATE; d2 : DATE; d3 : DATE;
    dy : INT; mo : INT; yr : INT;
    bc : INT; rv : BYTE; gr : BYTE; bcd : BYTE;
    z1 : COMPLEX; z2 : COMPLEX; cr : REAL; ca : REAL;
    pi1 : CTRL_PI; cd : CLK_DIV; ff : FIFO_16; hy : HYST; tpx : TP_X; pt1 : FT_PT1;
    dt1 : DT;
  END_VAR
  c := c + 1;
  g1 := GCD(c * 12, 18);              (* il C++ di STruC++ non termina: NOT(A.0 OR B.0) diventa un NOT bit a bit *)
  (* array tramite puntatori *)
  arr[c MOD 8 + 1] := arr[c MOD 8 + 1] + INT_TO_REAL(c);
  avg := ARRAY_AVG(ADR(arr), SIZEOF(arr));
  mx := ARRAY_MAX(ADR(arr), SIZEOF(arr));
  ok := _ARRAY_SORT(ADR(arr), SIZEOF(arr));
  (* stringhe tramite puntatori *)
  s1 := UPPERCASE('Ciao Mondo');
  s2 := LOWERCASE(CONCAT('ABC', INT_TO_STRING(c)));
  s3 := TRIM('  a b  c ');
  s4 := BYTE_TO_STRH(INT_TO_BYTE(c * 37));
  s5 := DWORD_TO_STRH(DINT_TO_DWORD(c * 123456));
  di := DEC_TO_INT(CONCAT('-', INT_TO_STRING(c * 11)));
  s6 := FILL(INT_TO_BYTE(65 + c), 3);
  s7 := REPLACE_ALL('a-b-c-d', '-', '+');
  s8 := CAPITALIZE('ciao bel mondo');
  fc := FIND_CHAR('12ab34', 1);
  nc := COUNT_CHAR('banana', 97);
  s9 := REAL_TO_STRF(INT_TO_REAL(c) * 1.5, 2, ',');
END_PROGRAM
