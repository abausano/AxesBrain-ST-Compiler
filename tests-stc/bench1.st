PROGRAM B
  VAR a : ARRAY[0..99] OF DINT; i : INT; s : DINT; r : REAL; T : ARRAY[0..9] OF INT; C : CTU; x : BOOL; END_VAR
  s := 0;
  FOR i := 0 TO 99 DO
    a[i] := a[i] + i;
    IF a[i] MOD 3 = 0 THEN s := s + a[i]; ELSE s := s - 1; END_IF
  END_FOR
  r := DINT_TO_REAL(s) * 0.5 + SQRT(2.0);
  x := NOT x;
  C(CU := x, R := FALSE, PV := 1000);
END_PROGRAM
