#!/usr/bin/env python
# coding: utf-8

"""
M5/M12模块集成可行性检查
"""

import sys
import os
import importlib.util
from pathlib import Path

def check_module(name, filepath):
    """检查模块可导入性"""
    print(f"检查 {name} 模块:")
    print(f"  文件路径: {filepath}")
    
    if not os.path.exists(filepath):
        print("  [ERROR] 文件不存在")
        return False, []
    
    try:
        spec = importlib.util.spec_from_file_location(name, filepath)
        if not spec:
            print("  [ERROR] spec创建失败")
            return False, []
        
        # 创建一个干净的模块
        module = importlib.util.module_from_spec(spec)
        
        # 尝试执行模块
        spec.loader.exec_module(module)
        print("  [OK] 模块导入成功")
        
        # 列出模块中的所有类
        classes = []
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if isinstance(attr, type):
                classes.append(attr_name)
        
        return True, classes
        
    except ImportError as e:
        print(f"  [ERROR] 导入依赖缺失: {e}")
        return False, []
    except Exception as e:
        print(f"  [ERROR] 导入失败: {e}")
        return False, []

def main():
    """主检查函数"""
    print("=" * 60)
    print("M5/M12模块集成可行性检查")
    print("=" * 60)
    
    script_dir = Path(__file__).parent.parent.parent
    oioioi_scripts_dir = script_dir / "oioioi" / "scripts"
    
    # 检查M5模块
    m5_file = oioioi_scripts_dir / "M5_AutoTest_Suite.py"
    m5_ok, m5_classes = check_module("M5_AutoTest_Suite", str(m5_file))
    
    if m5_ok:
        print(f"  M5模块中的类: {', '.join(m5_classes[:10])}")
    
    print("-" * 60)
    
    # 检查M12模块
    m12_file = oioioi_scripts_dir / "M12环境增强与OOD测试.py"
    m12_ok, m12_classes = check_module("M12环境增强与OOD测试", str(m12_file))
    
    if m12_ok:
        print(f"  M12模块中的类: {', '.join(m12_classes[:10])}")
    
    print("-" * 60)
    
    # 生成建议
    print("集成建议:")
    if not m5_ok:
        print("  1. M5模块需要pandas/numpy依赖，可安装或使用简化版")
    if not m12_ok:
        print("  2. M12模块可能需要其他依赖，检查模块文件")
    
    if m5_ok or m12_ok:
        print("  3. 防幻觉闸门系统已包含基本实现，可在无依赖下运行")
    
    print("-" * 60)
    
    # 检查简化版闸门
    print("简化版防幻觉闸门检查:")
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from accuracy_gate_simple import SimpleAccuracyGate
        print("  [OK] 简化版闸门可导入")
        
        # 测试实例化
        gate = SimpleAccuracyGate()
        print(f"  [OK] 闸门实例化成功: M5={gate.m5_available}, M12={gate.m12_available}")
        
        # 测试基本功能
        test_output = "这是一个测试输出。"
        result = gate.check_output(test_output, "test_001")
        print(f"  [OK] 闸门功能测试: 决策={result.gate_decision}")
        
    except Exception as e:
        print(f"  [ERROR] 简化版闸门检查失败: {e}")
    
    print("=" * 60)
    print("检查完成")

if __name__ == "__main__":
    main()