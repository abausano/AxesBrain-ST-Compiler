(* Confronto C++ / .stc: TYPE, STRUCT, enum, array multidimensionali e di FB,
   VAR_IN_OUT, uscite delle FUNCTION, VAR_TEMP, inizializzatori. *)

TYPE
  Stato : (Fermo, Avvio := 5, Marcia, Arresto);
  Punto : STRUCT
    x : REAL := 1.5;
    y : INT := -2;
  END_STRUCT;
  Pezzo : STRUCT
    nome : STRING(12) := 'pezzo';
    pos : Punto;
    quote : ARRAY[1..3] OF DINT := [10, 20, 30];
    st : Stato := Avvio;
  END_STRUCT;
  Matrice : ARRAY[0..2, 1..3] OF INT;
END_TYPE

FUNCTION Dividi : BOOL
  VAR_INPUT A : DINT; B : DINT; END_VAR
  VAR_OUTPUT Q : DINT; R : DINT; END_VAR
  IF B = 0 THEN
    Dividi := FALSE;
    RETURN;
  END_IF
  Q := A / B;
  R := A MOD B;
  Dividi := TRUE;
END_FUNCTION

FUNCTION Scambia : INT
  VAR_IN_OUT P : Punto; K : INT; END_VAR
  VAR_TEMP t : REAL; END_VAR
  t := P.x;
  P.x := INT_TO_REAL(P.y);
  P.y := REAL_TO_INT(t);
  K := K + 1;
  Scambia := K;
END_FUNCTION

FUNCTION SommaM : DINT
  VAR_INPUT M : Matrice; END_VAR
  VAR i : INT; j : INT; END_VAR
  FOR i := 0 TO 2 DO
    FOR j := 1 TO 3 DO
      SommaM := SommaM + M[i, j];
    END_FOR
  END_FOR
END_FUNCTION

FUNCTION Sposta : Punto
  VAR_INPUT P : Punto; D : REAL; END_VAR
  Sposta := P;
  Sposta.x := P.x + D;
END_FUNCTION

FUNCTION_BLOCK Contatore
  VAR_INPUT Inc : INT := 1; END_VAR
  VAR_OUTPUT N : DINT; END_VAR
  VAR_IN_OUT Totale : DINT; END_VAR
  VAR_TEMP tmp : DINT; END_VAR
  tmp := tmp + Inc;          (* VAR_TEMP: riparte da 0 a ogni chiamata *)
  N := N + tmp;
  Totale := Totale + tmp;
END_FUNCTION_BLOCK

PROGRAM Agg
  VAR
    c : INT;
    p1 : Punto;
    p2 : Punto := (y := 7);
    p3 : Punto;
    pz : Pezzo;
    pzs : ARRAY[1..2] OF Pezzo;
    m : Matrice;
    m3 : ARRAY[1..2, 1..2, 1..2] OF SINT;
    st : Stato;
    st2 : Stato := Stato#Arresto;
    q : DINT; r : DINT; ok : BOOL; ok2 : BOOL;
    k : INT := 100;
    ks : INT;
    somma : DINT;
    cnt : ARRAY[0..2] OF Contatore;
    tot : DINT;
    i : INT; j : INT;
    v : ARRAY[1..5] OF REAL := [1.0, 2.0, 3(0.5)];
    ultimo : REAL;
  END_VAR
  VAR_TEMP
    tp : INT;
  END_VAR

  c := c + 1;
  tp := tp + 1;
  (* struct *)
  p1.x := p1.x + 0.25;
  p1.y := p1.y + c;
  p3 := p1;
  pz.pos.y := pz.pos.y + 1;
  pz.quote[c MOD 3 + 1] := pz.quote[c MOD 3 + 1] + c;
  pzs[2] := pz;
  pzs[1].nome := CONCAT(pzs[1].nome, 'x');
  IF LEN(pzs[1].nome) > 10 THEN pzs[1].nome := 'p'; END_IF
  (* enum *)
  CASE st OF
    Fermo: st := Avvio;
    Avvio: st := Marcia;
    Marcia: st := Arresto;
  ELSE
    st := Fermo;
  END_CASE
  IF st2 = Stato#Arresto THEN st2 := Marcia; ELSE st2 := Arresto; END_IF
  (* array multidimensionali *)
  FOR i := 0 TO 2 DO
    FOR j := 1 TO 3 DO
      m[i, j] := i * 10 + j + c;
    END_FOR
  END_FOR
  m3[c MOD 2 + 1, 2, 1] := m3[c MOD 2 + 1, 2, 1] + 3;
  somma := SommaM(m);
  (* uscite di FUNCTION e VAR_IN_OUT *)
  ok := Dividi(100 + c, 7, Q => q, R => r);
  ok2 := Dividi(A := 1, B := 0);
  ks := Scambia(p2, k);
  p3 := Sposta(p3, 10.0);
  (* array di FB con VAR_IN_OUT *)
  FOR i := 0 TO 2 DO
    cnt[i](Inc := i + 1, Totale := tot);
  END_FOR
  cnt[1](Totale := tot);
  ultimo := v[5] + v[1];
  v[c MOD 5 + 1] := v[c MOD 5 + 1] * 2.0;
END_PROGRAM
