(* Confronto C++ / .stc: POINTER TO, ADR, ^, aritmetica dei puntatori, REF_TO, accesso ai bit. *)

FUNCTION SommaP : DINT
  VAR_INPUT p : POINTER TO ARRAY[0..9] OF INT; n : INT; END_VAR
  VAR i : INT; END_VAR
  FOR i := 0 TO n - 1 DO
    SommaP := SommaP + p^[i];
  END_FOR
END_FUNCTION

FUNCTION Azzera : BOOL
  VAR_INPUT p : POINTER TO BYTE; n : INT; END_VAR
  VAR i : INT; END_VAR
  FOR i := 1 TO n DO
    p^ := 0;
    p := p + 1;
  END_FOR
  Azzera := TRUE;
END_FUNCTION

PROGRAM Pun
  VAR
    c : INT;
    a : ARRAY[0..9] OF INT := [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    b : ARRAY[0..7] OF BYTE := [8(16#FF)];
    pi : POINTER TO INT;
    s : DINT;
    x : INT;
    r : REF_TO INT;
    y : INT;
    w : WORD := 16#00F0;
    b3 : BOOL; b4 : BOOL; b15 : BOOL;
    d : DWORD;
    ok : BOOL;
    pb : POINTER TO BYTE;
    k : INT;
  END_VAR

  c := c + 1;
  pi := ADR(a[2]);
  pi^ := pi^ + c;
  pi := pi + 2;
  x := pi^;
  s := SommaP(ADR(a), 10);
  IF c = 3 THEN                      (* Azzera(ADR(b[2]), 3): il C++ non compila POINTER TO BYTE come parametro *)
    pb := ADR(b[2]);
    FOR k := 1 TO 3 DO pb^ := 0; pb := pb + 1; END_FOR
  END_IF
  r := REF(y);
  r^ := r^ + 10;
  (* accesso ai bit *)
  b3 := w.3;
  b4 := w.4;
  w.0 := c MOD 2 = 1;
  w.15 := TRUE;
  b15 := w.15;
  d.31 := c > 4;
END_PROGRAM
