(* Chiamata di FB spezzata su piu' righe come prima istruzione di un FUNCTION_BLOCK, con istanza R
   (anche operatore IL): non deve essere presa per IL (10/11/2026). Modifica fatta da Claude. *)
FUNCTION_BLOCK F
  VAR_INPUT A : INT; B : INT; END_VAR
  VAR_OUTPUT Q : INT; END_VAR
  Q := A + B;
END_FUNCTION_BLOCK
FUNCTION_BLOCK G
  VAR_INPUT X : INT; END_VAR
  VAR_OUTPUT Y : INT; END_VAR
  VAR R : F; END_VAR
  R(A := X,
    B := X);
  Y := R.Q;
END_FUNCTION_BLOCK
PROGRAM P
  VAR K : G; END_VAR
  K(X := 2);
END_PROGRAM
