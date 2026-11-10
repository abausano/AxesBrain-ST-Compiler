(* Prova OOP del back-end .stc (INTERFACE, METHOD con STRING/STRUCT, PROPERTY STRING; oop5: interfaccia vuota = trappola). Modifica fatta da Claude. *)
INTERFACE IVal
  METHOD V : DINT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Uno IMPLEMENTS IVal
  METHOD V : DINT
    V := 1;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Prova5
  VAR U : Uno; I : IVal; R : DINT; END_VAR
  R := I.V();
END_PROGRAM
