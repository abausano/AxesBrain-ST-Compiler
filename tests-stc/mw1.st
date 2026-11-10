(* %MW = word dei 16 merker (%MW0 = %MX0.0 .. %MX1.7): scrittura della word, dei bit, lettura. Modifica fatta da Claude. *)
PROGRAM MW
  VAR
    Parola AT %MW0 : WORD;
    B1 AT %MX0.0 : BOOL;
    B10 AT %MX1.1 : BOOL;
    Altra AT %MW1 : WORD;
    B17 AT %MX2.0 : BOOL;
    Fase : DINT;
    Letta : WORD;
  END_VAR
  Fase := Fase + 1;
  IF Fase = 2 THEN
    Parola := 16#0201;
  END_IF
  IF Fase = 4 THEN
    B1 := FALSE;
    B17 := TRUE;
  END_IF
  Letta := Parola;
END_PROGRAM
