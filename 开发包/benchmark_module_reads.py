"""Measure data-loading allocations only, not browser/GPU or total application RAM."""
import argparse
import gc
import json
from pathlib import Path
import sys
import time
import tracemalloc
PACKAGE = Path(__file__).resolve().parent.parent/'程序包'
APP = next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
sys.path.insert(0,str(APP))
from server.save_storage import perform_local_save_operation

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True);parser.add_argument('--compact',action='store_true');args=parser.parse_args()
    root=Path(args.root);path=next(p for p in root.glob('战役/*/当前存档.json') if p.parent.name.startswith('c286'))
    peaks=[];retained=[];elapsed=[]
    tracemalloc.start()
    for _ in range(10):
        gc.collect();tracemalloc.reset_peak();start=time.perf_counter()
        if args.compact:
            loaded=perform_local_save_operation(dict(op='read-campaign',path=path.relative_to(root).as_posix()),root)
            state=json.loads(loaded['text'])['state'];del loaded
        else: state=json.loads(path.read_text('utf-8'))['state']
        assert len(state['maps'])==29
        elapsed.append(round(time.perf_counter()-start,4));peaks.append(tracemalloc.get_traced_memory()[1]);del state
        gc.collect();retained.append(tracemalloc.get_traced_memory()[0])
    print(json.dumps(dict(mode='compact' if args.compact else 'legacy',cycles=10,peakMiB=round(max(peaks)/1048576,2),retainedMiB=[round(v/1048576,3) for v in retained],seconds=elapsed,scope='Python data loading only; excludes browser image/GPU memory'),ensure_ascii=False))
