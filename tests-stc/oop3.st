(* Prova OOP del back-end .stc (METHOD, PROPERTY, EXTENDS, SUPER, chiamata virtuale). Modifica fatta da Claude. *)
FUNCTION_BLOCK ABSTRACT Base
  METHOD ABSTRACT Valore : DINT
  END_METHOD
  METHOD Doppio : DINT
    Doppio := Valore() * 2;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Tre EXTENDS Base
  METHOD Valore : DINT
    Valore := 3;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Sette EXTENDS Base
  METHOD Valore : DINT
    Valore := 7;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Prova3
  VAR A : Tre; B : Sette; RA : DINT; RB : DINT; END_VAR
  RA := A.Doppio();
  RB := B.Doppio() + B.Valore();
END_PROGRAM
