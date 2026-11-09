(* Trappola: dereferenziazione di un puntatore nullo al terzo ciclo. *)
PROGRAM T4
  VAR p : POINTER TO DINT; x : DINT; giri : INT; END_VAR
  giri := giri + 1;
  IF giri < 3 THEN p := ADR(x); ELSE p := 0; END_IF
  p^ := p^ + 1;
END_PROGRAM
