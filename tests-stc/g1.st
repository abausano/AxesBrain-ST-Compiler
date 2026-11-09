(* Globali G: scrittura, lettura, copie a blocchi, indici fuori intervallo. *)
PROGRAM G1
  VAR
    Ok1, Ok2, Ok3 : BOOL;
    A : LREAL;
    B : LREAL;
    Fuori : LREAL;
    Arr : ARRAY[1..4] OF LREAL := [1.5, 2.5, 3.5, 4.5];
    Letti : ARRAY[0..3] OF LREAL;
    NCopiati, NLetti, NFuori : INT;
    Giro : INT;
  END_VAR
  Giro := Giro + 1;
  Ok1 := AB_SETG(100, 21.0 * INT_TO_LREAL(Giro));
  A := AB_GETG(100);
  B := AB_GETG(32767);
  Ok2 := AB_SETG(0, 1.0);
  Ok3 := AB_SETG(32768, 1.0);
  Fuori := AB_GETG(40000);
  NCopiati := AB_SETG_N(200, 4, ADR(Arr));
  NLetti := AB_GETG_N(201, 3, ADR(Letti));
  NFuori := AB_GETG_N(32766, 4, ADR(Letti));
END_PROGRAM
