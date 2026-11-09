PROGRAM L
  VAR
    In1 : BOOL;
    T1 : TON; T2 : TOF; T3 : TP; C1 : CTU; RT : R_TRIG; FT : F_TRIG; B1 : SR;
    fronti : INT; discese : INT;
  END_VAR
  T1(IN := In1, PT := T#30ms);
  T2(IN := In1, PT := T#30ms);
  T3(IN := In1, PT := T#20ms);
  RT(CLK := In1);
  FT(CLK := In1);
  IF RT.Q THEN fronti := fronti + 1; END_IF
  IF FT.Q THEN discese := discese + 1; END_IF
  C1(CU := In1, R := FALSE, PV := 2);
  B1(S1 := RT.Q, R := FT.Q);
END_PROGRAM
