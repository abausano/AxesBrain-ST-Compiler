(* Prove del prototipo: aritmetica, CASE, cicli, funzioni, FB annidati, globali, I/O. *)

VAR_GLOBAL
  GCont : DINT := 100;
  Ingresso AT %IX0.0 : BOOL;
  Uscita AT %QX1.2 : BOOL;
  Analog AT %IW3 : INT;
END_VAR

FUNCTION Somma3 : DINT
  VAR_INPUT A : DINT; B : DINT := 10; C : DINT := 100; END_VAR
  Somma3 := A + B + C;
END_FUNCTION

FUNCTION PrimoPari : INT
  VAR_INPUT N : INT; END_VAR
  VAR I : INT; END_VAR
  PrimoPari := -1;
  FOR I := N TO N + 10 DO
    IF I MOD 2 = 0 THEN
      PrimoPari := I;
      RETURN;
    END_IF
  END_FOR
END_FUNCTION

FUNCTION_BLOCK Interno
  VAR_INPUT X : INT; END_VAR
  VAR_OUTPUT Y : INT; END_VAR
  Y := X * 3;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Esterno
  VAR_INPUT V : INT; END_VAR
  VAR_OUTPUT R : INT; Chiamate : INT; END_VAR
  VAR F : Interno; END_VAR
  F(X := V);
  R := F.Y + 1;
  Chiamate := Chiamate + 1;
END_FUNCTION_BLOCK

PROGRAM Prove
  VAR_EXTERNAL GCont : DINT; END_VAR
  VAR
    i16 : INT := 32767;
    w : WORD := 16#00F0;
    d : DINT := 2147483647;
    ud : UDINT := 0;
    ul : ULINT := 0;
    r : REAL;
    lr : LREAL;
    n1 : INT; n2 : INT; n3 : DINT;
    caso : INT;
    sCase : INT;
    k : INT;
    somma : DINT;
    rep : INT;
    arr : ARRAY[0..4] OF DINT;
    E1 : Esterno;
    risE : INT;
    cicli : DINT;
    mn : INT; mx : INT; lim : INT; sl : INT;
    tr : DINT; sh : WORD;
    eco : BOOL;
    an2 : INT;
  END_VAR

  cicli := cicli + 1;

  (* overflow e conversioni *)
  i16 := i16 + 1;                 (* 32767 + 1 -> -32768 *)
  w := NOT w;                      (* 16#FF0F = 65295 *)
  d := d + 1;                      (* -> -2147483648 *)
  ud := ud - 1;                    (* -> 4294967295 *)
  ul := ul - 1;                    (* -> 18446744073709551615 *)
  r := 1.0 / 3.0;
  lr := 1.0 / 3.0;
  n1 := REAL_TO_INT(2.5);          (* 3 *)
  n2 := REAL_TO_INT(-2.5);         (* -3 *)
  n3 := TRUNC(-7.9);               (* -7 *)

  (* CASE con intervalli ed ELSE *)
  caso := caso + 1;
  CASE caso OF
    1: sCase := 10;
    2, 3: sCase := 20;
    4..6: sCase := 30;
  ELSE
    sCase := 99;
  END_CASE

  (* cicli *)
  somma := 0;
  FOR k := 10 TO 1 BY -3 DO somma := somma + k; END_FOR     (* 10+7+4+1 = 22 *)
  k := 0;
  WHILE TRUE DO
    k := k + 1;
    IF k >= 5 THEN EXIT; END_IF
  END_WHILE
  rep := 0;
  REPEAT rep := rep + 2; UNTIL rep > 7 END_REPEAT          (* 8 *)

  (* array *)
  FOR k := 0 TO 4 DO arr[k] := Somma3(k, C := 1000); END_FOR (* k + 10 + 1000 *)

  (* FB annidati *)
  E1(V := 5, R => risE);                                    (* 16 *)

  (* standard *)
  mn := MIN(7, 3, 9);
  mx := MAX(7, 3, 9);
  lim := LIMIT(0, 150, 100);
  sl := SEL(TRUE, 1, 2);
  tr := PrimoPari(7);                                       (* 8 *)
  sh := SHL(w, 4);

  (* globali e I/O *)
  GCont := GCont + 1;
  eco := Ingresso;
  Uscita := Ingresso;
  an2 := Analog * 2;
END_PROGRAM
