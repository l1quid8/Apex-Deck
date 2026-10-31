H=/home/tester/jh4; P=/home/tester/proj4; rm -rf $H $P; mkdir -p $H $P; export PROXY_LOG=/tmp/p4.log; rm -f $PROXY_LOG
JAIL_GEMINI_CLI_TRUST_WORKSPACE=true JAIL_GEMINI_API_KEY=bad-key python3 /spike/jail.py $P $H -- timeout 60 gemini -p 'say hi' 2>&1 | tail -5 | cut -c1-260
sort $PROXY_LOG | uniq -c
