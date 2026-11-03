import struct,sys
LD,JEQ,JSET,RET,ALU_AND=0x20,0x15,0x45,0x06,0x54
ALLOW=0x7fff0000
def errno(e): return 0x00050000|e
X86=0xc000003e; ARM=0xc00000b7
class P:
    def __init__(s): s.i=[]; s.l={}
    def op(s,c,k=0,jt=None,jf=None): s.i.append((c,jt,jf,k))
    def lab(s,n): s.l[n]=len(s.i)
    def out(s):
        b=b''
        for n,(c,jt,jf,k) in enumerate(s.i):
            r=lambda x:0 if x is None else s.l[x]-n-1
            b+=struct.pack('<HBBI',c,r(jt),r(jf),k)
        return b
def build():
    p=P()
    p.op(LD,4); p.op(JEQ,X86,'x86',None); p.op(JEQ,ARM,'arm',None); p.op(RET,errno(38))
    p.lab('x86'); p.op(LD,0); p.op(JSET,0x40000000,'enosys',None)
    p.op(JEQ,41,'sock',None); p.op(JEQ,53,'pair',None); p.op(JEQ,425,'enosys',None); p.op(RET,ALLOW)
    p.lab('arm'); p.op(LD,0)
    p.op(JEQ,198,'sock',None); p.op(JEQ,199,'pair',None); p.op(JEQ,425,'enosys',None); p.op(RET,ALLOW)
    p.lab('sock'); p.op(LD,16); p.op(JEQ,1,'noaf',None); p.op(RET,ALLOW)
    p.lab('pair'); p.op(LD,24); p.op(ALU_AND,0xfff7f7ff); p.op(JEQ,1,'ok',None); p.op(RET,errno(1))
    p.lab('ok'); p.op(RET,ALLOW)
    p.lab('noaf'); p.op(RET,errno(97))
    p.lab('enosys'); p.op(RET,errno(38))
    return p.out()
if __name__=='__main__': open(sys.argv[1],'wb').write(build())
